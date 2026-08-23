'use strict';

const { getSystemPrompt, getAvailableToolNames, supportsNativeToolCalling } = require('./prompts');
const tools = require('./tools');
const memory = require('./memory');
const { TOOL_SCHEMAS } = tools;

// Allow multi-step task execution. Bumped from 15: with write_plan encouraging explicit
// step tracking and git_checkpoint/git_revert making mistakes cheap to undo, longer
// multi-file tasks (the ones local models most need help staying on track for) were
// hitting the old ceiling before finishing.
const MAX_TOOL_ITERATIONS = 25;

// Buckets for the num_ctx we actually request from Ollama. Rather than always asking
// for the model's full (capped) context window — which forces Ollama to allocate a
// KV cache sized for the worst case on every single request — we size num_ctx to the
// smallest bucket that comfortably fits the current conversation. This meaningfully
// reduces memory allocation and speeds up prompt processing for short exchanges on
// local hardware, at the cost of a (rare) context resize if a conversation suddenly
// grows a lot within one exchange — which _buildContextMessages already guards
// against by trimming to budget first.
const NUM_CTX_BUCKETS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];

/**
 * Pick the smallest num_ctx bucket that fits `neededTokens` (with headroom),
 * capped at `maxContext` (the model's own — possibly capped — context size).
 */
function bucketNumCtx(neededTokens, maxContext) {
  for (const bucket of NUM_CTX_BUCKETS) {
    if (bucket >= maxContext) return maxContext;
    if (neededTokens <= bucket) return bucket;
  }
  return maxContext;
}

/**
 * Rough token estimator — ~3.5 chars per token for English/code.
 * This avoids needing a real tokenizer while being conservative enough.
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

/**
 * Parses tool call blocks from the LLM response text.
 * Looks for ```tool\n{...}\n``` patterns.
 * Includes robust recovery for malformed JSON (common with local models).
 */
function parseToolCalls(responseText) {
  const toolCalls = [];
  const toolBlockRegex = /```tool\s*\n([\s\S]*?)```/g;
  let match;

  while ((match = toolBlockRegex.exec(responseText)) !== null) {
    const jsonStr = match[1].trim();
    const parsed = tryParseToolJSON(jsonStr);
    if (parsed && parsed.tool && typeof parsed.tool === 'string') {
      toolCalls.push({
        tool: parsed.tool,
        params: parsed.params || {},
      });
    }
  }

  return toolCalls;
}

/**
 * Counts how many ```tool``` blocks appear in the response, regardless of whether they
 * parsed successfully. Compared against parseToolCalls(text).length in the agent loop
 * to detect "the model tried to call a tool but the JSON was unrecoverably broken" —
 * previously that case was silently indistinguishable from "no tool call was intended
 * at all", so a malformed call just vanished with no feedback to the model.
 */
function countToolBlockAttempts(responseText) {
  const toolBlockRegex = /```tool\s*\n([\s\S]*?)```/g;
  let count = 0;
  while (toolBlockRegex.exec(responseText) !== null) count++;
  return count;
}

/**
 * Try to parse tool JSON with multiple recovery strategies.
 * Local models often produce broken JSON (unescaped quotes in HTML, bad escapes).
 */
function tryParseToolJSON(jsonStr) {
  // Strategy 1: Strict parse
  try {
    return JSON.parse(jsonStr);
  } catch { /* continue */ }

  // Strategy 2: Fix common escape issues
  try {
    // Fix unescaped control characters inside strings
    const fixed = jsonStr
      .replace(/\t/g, '\\t')
      .replace(/[\x00-\x1f]/g, (c) => {
        if (c === '\n' || c === '\r') return c; // keep structural newlines
        return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
      });
    return JSON.parse(fixed);
  } catch { /* continue */ }

  // Strategy 3: Extract tool name and params via regex (last resort)
  try {
    const toolMatch = jsonStr.match(/"tool"\s*:\s*"([^"]+)"/);
    if (!toolMatch) return null;

    const tool = toolMatch[1];

    // Try to extract the params object
    const paramsMatch = jsonStr.match(/"params"\s*:\s*\{/);
    if (!paramsMatch) {
      return { tool, params: {} };
    }

    // For create_file: extract path and content separately
    const pathMatch = jsonStr.match(/"path"\s*:\s*"([^"]*?)"/);
    const contentMatch = jsonStr.match(/"content"\s*:\s*"([\s\S]*?)"\s*\n?\s*\}/);
    const commandMatch = jsonStr.match(/"command"\s*:\s*"([^"]*?)"/);
    const urlMatch = jsonStr.match(/"url"\s*:\s*"([^"]*?)"/);
    const oldContentMatch = jsonStr.match(/"old_content"\s*:\s*"([\s\S]*?)"/);
    const newContentMatch = jsonStr.match(/"new_content"\s*:\s*"([\s\S]*?)"\s*\n?\s*\}/);

    const params = {};
    if (pathMatch) params.path = pathMatch[1];
    if (commandMatch) params.command = commandMatch[1];
    if (contentMatch) {
      // Unescape the content
      params.content = contentMatch[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
    }
    if (oldContentMatch) {
      params.old_content = oldContentMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
    if (newContentMatch) {
      params.new_content = newContentMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }

    console.log(`[AgentCore] Recovered tool call via regex: ${tool}(${Object.keys(params).join(', ')})`);
    return { tool, params };
  } catch (err) {
    console.warn('[AgentCore] All JSON parse strategies failed:', err.message);
    return null;
  }
}

/**
 * Converts Ollama's native tool_calls format into the internal {tool, params} shape
 * used by the execution loop. `arguments` may come back as a parsed object or as a
 * raw JSON string depending on the model/Ollama version, so we handle both.
 */
function convertNativeToolCalls(nativeToolCalls) {
  const converted = [];
  for (const call of nativeToolCalls) {
    const fn = call.function || call;
    if (!fn || !fn.name) continue;

    let params = fn.arguments;
    if (typeof params === 'string') {
      try {
        params = JSON.parse(params);
      } catch {
        console.warn(`[AgentCore] Failed to parse native tool_call arguments for "${fn.name}":`, params);
        params = {};
      }
    }
    if (!params || typeof params !== 'object') params = {};

    converted.push({ tool: fn.name, params });
  }
  return converted;
}

/**
 * Strips tool call blocks from the response text to get the "plain" assistant message.
 */
function stripToolBlocks(responseText) {
  return responseText.replace(/```tool\s*\n[\s\S]*?```/g, '').trim();
}

class AgentCore {
  /**
   * @param {import('../ollama/client')} ollamaClient
   */
  constructor(ollamaClient, maxContextCap = 16384, provider = 'ollama') {
    if (!ollamaClient) {
      throw new Error('OllamaClient instance is required');
    }
    this.ollamaClient = ollamaClient;
    this._isGenerating = false;
    this._contextSizeCache = {};  // model → context_size cache
    this.maxContextCap = maxContextCap; // user-configurable ceiling, see setMaxContextCap()
    this._contextSummaryCache = {};  // conversation fingerprint → { droppedCount, summary }
    // Which backend `this.ollamaClient` currently points at: 'ollama' | 'deepseek' |
    // 'openai' | 'anthropic'. Despite the property name (kept for backward
    // compatibility), it holds whichever client main.js's getActiveClient() selected.
    this.provider = provider;
  }

  /** Update which provider `this.ollamaClient` represents — call this any time main.js swaps the active client. */
  setProvider(provider) {
    if (!provider || provider === this.provider) return;
    this.provider = provider;
    // The cap-vs-no-cap logic in _getContextSize depends on the provider, so a
    // cached value from before the switch could be stale (or wrongly capped/uncapped).
    this._contextSizeCache = {};
  }

  /**
   * Update the user-configurable context-size ceiling (from Settings). Clears the
   * per-model cache so the new cap takes effect on the next request rather than
   * being masked by a previously-cached (smaller or larger) value.
   */
  setMaxContextCap(maxContextCap) {
    const parsed = parseInt(maxContextCap, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    this.maxContextCap = parsed;
    this._contextSizeCache = {};
    console.log(`[AgentCore] Max context cap set to ${this.maxContextCap}`);
  }

  /**
   * Get the model's maximum context window size (cached after first lookup).
   *
   * `this.maxContextCap` (default 16384, user-configurable in Settings) is ONLY applied
   * for the `ollama` provider — it exists to protect local RAM/VRAM from an oversized
   * KV cache, which has no equivalent for cloud APIs. Cloud providers (OpenAI, Anthropic,
   * DeepSeek) bill by token but don't have that local memory-pressure problem, so capping
   * them the same way just silently throws away most of e.g. Claude's 200K or GPT's 128K
   * window for no benefit. This is the ceiling used for history-budgeting
   * (_buildContextMessages) — the actual num_ctx sent to Ollama per-request is chosen
   * separately by bucketNumCtx() based on how many tokens are really needed.
   */
  async _getContextSize(model) {
    if (this._contextSizeCache[model]) {
      return this._contextSizeCache[model];
    }
    const rawSize = await this.ollamaClient.getContextSize(model);
    const size = this.provider === 'ollama' ? Math.min(rawSize, this.maxContextCap) : rawSize;
    this._contextSizeCache[model] = size;
    console.log(`[AgentCore] Model "${model}" (${this.provider}) context: ${rawSize}${size !== rawSize ? ` (capped to ${size})` : ''}`);
    return size;
  }

  /**
   * A cheap, stable-enough fingerprint for "which conversation is this" — used to key
   * the rolling summary cache. main.js reconstructs a fresh conversationHistory array
   * on every IPC call even for the same ongoing chat, so we can't key by array identity;
   * the first message's content is stable for the lifetime of a chat, so it's a good
   * enough proxy without threading a real chatId through the IPC layer.
   */
  _conversationFingerprint(model, conversationHistory) {
    const first = conversationHistory[0];
    const anchor = first && typeof first.content === 'string' ? first.content.slice(0, 100) : '';
    return `${model}::${anchor}`;
  }

  /**
   * Ask the model to fold newly-dropped history into (or replace) the running summary.
   * Bounded and time-limited (20s) since this runs inline in the agent loop before the
   * "real" turn even starts — if it's slow or the model ignores the instruction, we abort
   * and fall back to the cheap tool-name-list note instead of stalling the whole request.
   * @returns {Promise<string|null>} - the updated summary, or null on failure/timeout
   */
  async _summarizeDroppedHistory(model, previousSummary, newlyDroppedText) {
    const prompt = `You are compressing an ongoing coding/security-agent session log so it fits in a smaller context window.
Merge the previous summary with the new content below into ONE updated summary, under 120 words, plain prose (no lists).
Preserve: the user's goal, files created/edited, commands run and their outcomes, and any unresolved next steps. Drop anything not needed to continue the task.

Previous summary: ${previousSummary || '(none yet)'}

New content to fold in:
${newlyDroppedText}`;

    const SUMMARY_TIMEOUT_MS = 20000;
    let timedOut = false;

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        timedOut = true;
        try { this.ollamaClient.abort(); } catch { /* best-effort */ }
        resolve(null);
      }, SUMMARY_TIMEOUT_MS);
    });

    const chatPromise = this.ollamaClient
      .chat(model, [{ role: 'user', content: prompt }], () => {}, { contextSize: 4096, temperature: 0.2 })
      .then((result) => (timedOut || !result || !result.text ? null : result.text.trim()))
      .catch((err) => {
        console.warn('[AgentCore] Context summarization failed:', err.message);
        return null;
      });

    return Promise.race([chatPromise, timeoutPromise]);
  }

  /**
   * Build the messages array that fits within the model's context budget.
   * Strategy:
   *   1. Always include system prompt
   *   2. Reserve 40% of context for the model's response
   *   3. Fill remaining budget from newest conversation messages backward
   *   4. If a message is too large, truncate its content
   *   5. If older messages are dropped, fold them into a running LLM-generated summary
   *      (falling back to a cheap tool-name-only note if summarization fails/times out)
   */
  async _buildContextMessages(systemMessage, conversationHistory, contextSize, model) {
    const systemTokens = estimateTokens(systemMessage.content);
    const responseReserve = Math.floor(contextSize * 0.4);  // 40% for response
    let budget = contextSize - systemTokens - responseReserve;

    if (budget < 200) budget = 200; // absolute minimum

    // Walk backward through history, adding messages until budget runs out
    const selectedMessages = [];
    let droppedCount = 0;

    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const msg = conversationHistory[i];
      let msgTokens = estimateTokens(msg.content);

      if (msgTokens > budget) {
        // If this is the most recent message (must include), truncate it
        if (selectedMessages.length === 0) {
          const maxChars = Math.floor(budget * 3.5);
          selectedMessages.unshift({
            role: msg.role,
            content: msg.content.substring(0, maxChars) + '\n... (truncated)',
          });
        }
        droppedCount = i + 1;
        break;
      }

      selectedMessages.unshift(msg);
      budget -= msgTokens;

      if (budget <= 0) {
        droppedCount = i;
        break;
      }
    }

    // If messages were dropped, fold them into a rolling summary so the model doesn't
    // lose track of what already happened once history no longer fits the budget.
    if (droppedCount > 0) {
      const fingerprint = this._conversationFingerprint(model, conversationHistory);
      const cache = this._contextSummaryCache[fingerprint];
      let summaryText = cache && cache.droppedCount === droppedCount ? cache.summary : null;

      if (!summaryText) {
        const sinceIndex = cache ? cache.droppedCount : 0;
        const newlyDropped = conversationHistory.slice(sinceIndex, droppedCount);

        if (newlyDropped.length > 0) {
          const newlyDroppedText = newlyDropped
            .map(m => `[${m.role}] ${m.content}`)
            .join('\n')
            .slice(-3000); // bound the summarizer's own input regardless of how much was dropped at once

          const generated = await this._summarizeDroppedHistory(model, cache ? cache.summary : null, newlyDroppedText);
          if (generated) {
            summaryText = generated;
            this._contextSummaryCache[fingerprint] = { droppedCount, summary: generated };
          }
        }
      }

      if (summaryText) {
        selectedMessages.unshift({
          role: 'system',
          content: `[Summary of earlier conversation — trimmed to fit context]\n${summaryText}`,
        });
      } else {
        // Fallback: cheap tool-name-only note, used when summarization fails, times
        // out, or the model hasn't produced anything usable yet.
        const droppedMessages = conversationHistory.slice(0, droppedCount);
        const completedTools = [];
        for (const msg of droppedMessages) {
          if (msg.role === 'user' && msg.content.startsWith('Tool results:')) {
            const toolMatches = msg.content.match(/\[Tool Result: (\w+)\]/g);
            if (toolMatches) {
              toolMatches.forEach(m => completedTools.push(m.replace('[Tool Result: ', '').replace(']', '')));
            }
          }
        }

        if (completedTools.length > 0) {
          const summary = `[Context note: Earlier messages were trimmed. Previously completed: ${completedTools.join(', ')} (${completedTools.length} tool operations). Continue from where you left off.]`;
          selectedMessages.unshift({ role: 'system', content: summary });
        }
      }
    }

    return [systemMessage, ...selectedMessages];
  }

  /**
   * Detect if pasted text is output from a security scanning tool.
   * Returns the tool name or null.
   */
  _detectScanOutput(text) {
    const checks = [
      { pattern: /Nmap scan report|PORT\s+STATE\s+SERVICE|nmap done/i, label: 'nmap' },
      { pattern: /nikto.*target|OSVDB-|anti-clickjacking/i, label: 'nikto' },
      { pattern: /sqlmap|injection|--dbs|fetched data/i, label: 'sqlmap' },
      { pattern: /\[DATA\].*\[ATTEMPT\]|\[STATUS\].*login|hydra/i, label: 'hydra' },
      { pattern: /enum4linux|Sharename|Domain.*SID/i, label: 'enum4linux' },
      { pattern: /gobuster|feroxbuster|Status: (200|301|403|404)/i, label: 'gobuster' },
      { pattern: /msf\d?>|meterpreter>|exploit completed|session \d+ opened/i, label: 'metasploit' },
      { pattern: /searchsploit|Exploit Title.*Path|exploitdb/i, label: 'searchsploit' },
      { pattern: /\d+\/tcp\s+(open|closed|filtered)/i, label: 'port scan' },
      { pattern: /CVE-\d{4}-\d+/i, label: 'vulnerability report' },
      { pattern: /meterpreter|reverse.*shell|payload.*executed/i, label: 'exploitation' },
    ];

    for (const { pattern, label } of checks) {
      if (pattern.test(text)) return label;
    }
    return null;
  }

  /**
   * Detect if user request is a vague project-level command.
   */
  _isProjectLevelRequest(message) {
    const lower = message.toLowerCase();
    const triggers = [
      // Coding
      'finish', 'complete', 'continue', 'fix', 'clean', 'debug',
      'error', 'build', 'run', 'test', 'deploy', 'review',
      'what is this', 'analyze', 'improve', 'refactor', 'update',
      // Security
      'scan', 'audit', 'vulnerability', 'vuln', 'exploit', 'pentest',
      'recon', 'secure', 'hardcoded', 'injection', 'xss',
      // Burmese
      'ဆက်', 'ပြီးအောင်', 'ပြင်', 'စစ်', 'ရှာ',
    ];
    return message.length < 200 && triggers.some(t => lower.includes(t));
  }

  /**
   * Scan project folder and read key files to build context.
   * Returns a compact summary string.
   */
  async _scanProjectContext(projectFolder) {
    const fs = require('fs');
    const path = require('path');

    try {
      // List top-level files
      const entries = fs.readdirSync(projectFolder, { withFileTypes: true });
      const files = [];
      const dirs = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' ||
            entry.name === '__pycache__' || entry.name === 'venv' || entry.name === '.git') {
          continue;
        }
        if (entry.isDirectory()) {
          dirs.push(entry.name);
        } else {
          files.push(entry.name);
        }
      }

      let context = `Files: ${files.join(', ')}\nFolders: ${dirs.join(', ') || '(none)'}\n`;

      // Read key project files (limited to 2KB each to stay within context budget)
      const keyFiles = files.filter(f => {
        const ext = path.extname(f).toLowerCase();
        return ['.py', '.js', '.ts', '.html', '.json', '.css', '.yaml', '.yml', '.txt', '.md', '.toml']
          .includes(ext) || f === 'Makefile' || f === 'Dockerfile';
      });

      const MAX_FILE_SIZE = 2048; // 2KB per file
      const MAX_TOTAL_CONTEXT = 4000; // 4KB total context budget

      for (const fileName of keyFiles.slice(0, 8)) { // Max 8 files
        if (estimateTokens(context) > MAX_TOTAL_CONTEXT / 3.5) break;

        try {
          const filePath = path.join(projectFolder, fileName);
          const stat = fs.statSync(filePath);
          if (stat.size > 20000) { // Skip huge files
            context += `\n--- ${fileName} (${stat.size} bytes, too large to include) ---\n`;
            continue;
          }
          let content = fs.readFileSync(filePath, 'utf-8');
          if (content.length > MAX_FILE_SIZE) {
            content = content.substring(0, MAX_FILE_SIZE) + '\n... (truncated)';
          }
          context += `\n--- ${fileName} ---\n${content}\n`;
        } catch { /* skip unreadable files */ }
      }

      // Also scan one level deep for template/view files
      for (const dir of dirs.slice(0, 3)) {
        try {
          const dirPath = path.join(projectFolder, dir);
          const subEntries = fs.readdirSync(dirPath);
          const subFiles = subEntries.filter(f => !f.startsWith('.')).slice(0, 5);
          if (subFiles.length > 0) {
            context += `\n${dir}/: ${subFiles.join(', ')}\n`;
          }
        } catch { /* skip */ }
      }

      return context;
    } catch (err) {
      console.warn('[AgentCore] Failed to scan project:', err.message);
      return null;
    }
  }

  /**
   * Process a user message through the agentic loop.
   *
   * @param {string} userMessage - The user's input message
   * @param {string} model - The Ollama model to use
   * @param {Array<{role: string, content: string}>} conversationHistory - Mutable conversation history array
   * @param {function(string): void} onToken - Called with each streaming text token
   * @param {function({tool: string, params: object, result: string}): void} onToolExecution - Called when a tool is executed
   * @param {string|null} projectFolder - Active project folder path
   * @param {function({status: string, message: string, data?: object}): void} onStatus - Called with status updates
   * @param {?function(string, string): (boolean|Promise<boolean>)} onConfirmCommand - Called with
   *   (command, label) before a run_command "risky but allowed" pattern executes; should resolve to
   *   true/false. Pass null (or omit) to skip confirmation entirely — e.g. when the user has turned
   *   the Settings → Safety toggle off — in which case run_command behaves exactly as before
   *   (auto-allowed with just a warning label). See src/agent/tools.js's run_command.
   * @returns {Promise<{response: string, toolResults: Array<{tool: string, params: object, result: string}>}>}
   */
  async processMessage(userMessage, model, conversationHistory, onToken = () => {}, onToolExecution = () => {}, projectFolder = null, onStatus = () => {}, onConfirmCommand = null) {
    if (!userMessage || typeof userMessage !== 'string') {
      throw new Error('User message is required');
    }
    if (!model || typeof model !== 'string') {
      throw new Error('Model name is required');
    }

    this._isGenerating = true;
    const allToolResults = [];

    try {
      // Auto-inject project context for vague requests like "finish", "fix", "continue"
      let enrichedMessage = userMessage;
      if (projectFolder && this._isProjectLevelRequest(userMessage)) {
        onStatus({ status: 'thinking', message: 'Scanning project...' });
        const projectContext = await this._scanProjectContext(projectFolder);
        if (projectContext) {
          enrichedMessage = `${userMessage}\n\n[Project Context — auto-scanned]\n${projectContext}`;
          console.log(`[AgentCore] Injected project context (${estimateTokens(projectContext)} tokens)`);
        }
      }

      // Auto-detect pasted scan results and label them for the model
      if (userMessage.length > 200) {
        const scanLabel = this._detectScanOutput(userMessage);
        if (scanLabel) {
          enrichedMessage = `[Pasted ${scanLabel} output — analyze this and suggest next steps]\n\n${enrichedMessage}`;
          console.log(`[AgentCore] Detected pasted ${scanLabel} output`);
        }
      }

      // Auto-recall relevant long-term project memory (see agent/memory.js) — this is
      // what lets the model "remember" facts saved via save_memory in earlier sessions
      // even after they've long since been trimmed out of / were never in this
      // conversation's context. Only injects when something actually matches, so it
      // doesn't add noise to every single message.
      if (projectFolder) {
        try {
          const recalled = memory.searchMemory(projectFolder, userMessage, 3);
          if (recalled.length > 0) {
            enrichedMessage = `${enrichedMessage}\n\n[Relevant project memory — recalled automatically]\n${memory.formatMemoryEntries(recalled)}`;
            console.log(`[AgentCore] Auto-recalled ${recalled.length} memory entr${recalled.length === 1 ? 'y' : 'ies'}`);
          }
        } catch (err) {
          console.warn('[AgentCore] Memory auto-recall failed:', err.message);
        }
      }

      // Add user message to history
      conversationHistory.push({ role: 'user', content: enrichedMessage });

      // Build messages array with system prompt prepended (model-aware for security
      // models, and message-aware so the large pentest/red-team playbook is only
      // included when this task actually looks security-related — see prompts.js).
      const systemMessage = { role: 'system', content: getSystemPrompt(projectFolder, model, userMessage) };

      let iteration = 0;
      let finalResponse = '';

      while (iteration < MAX_TOOL_ITERATIONS) {
        iteration++;

        if (!this._isGenerating) {
          break;
        }

        // Emit thinking status with step number
        onStatus({
          status: 'thinking',
          message: iteration === 1
            ? 'Planning and analyzing...'
            : `Step ${iteration}: Processing results...`,
        });

        // Smart context: detect model's max context window, build messages within budget
        const maxContextSize = await this._getContextSize(model);
        const messages = await this._buildContextMessages(systemMessage, conversationHistory, maxContextSize, model);

        // Right-size num_ctx to what this request actually needs instead of always
        // requesting the model's full (capped) window — smaller KV cache, faster prompt
        // processing, less RAM/VRAM pressure on local hardware.
        const neededTokens = messages.reduce((s, m) => s + estimateTokens(m.content), 0);
        const numCtx = bucketNumCtx(neededTokens, maxContextSize);

        // Native Ollama function-calling is only reliable on a handful of model families;
        // everyone else keeps using the markdown ```tool``` block convention from the
        // system prompt (parsed by parseToolCalls below).
        const useNativeTools = supportsNativeToolCalling(model, this.provider);

        console.log(`[AgentCore] Iteration ${iteration}: ${messages.length} messages, ~${neededTokens} tokens (num_ctx: ${numCtx}/${maxContextSize}, native tools: ${useNativeTools})`);

        // Stream the LLM response
        let currentResponse = '';
        let firstToken = false;
        let insideThinkBlock = false;

        const chatResult = await this.ollamaClient.chat(model, messages, (token) => {
          if (this._isGenerating) {
            // Track <think>...</think> blocks — don't stream thinking to UI
            if (token.includes('<think>')) {
              insideThinkBlock = true;
            }
            if (insideThinkBlock) {
              if (token.includes('</think>')) {
                insideThinkBlock = false;
              }
              return; // skip think tokens
            }

            if (!firstToken) {
              firstToken = true;
              onStatus({ status: 'generating', message: 'Writing response...' });
            }
            onToken(token);
          }
        }, {
          contextSize: numCtx,
          tools: useNativeTools ? TOOL_SCHEMAS : undefined,
          onProgress: (progress) => {
            if (progress.event === 'progress') {
              onStatus({ status: 'generating', message: `Generating... ${progress.tokensPerSec} tok/s` });
            }
          },
        });

        currentResponse = chatResult.text;
        const nativeToolCalls = chatResult.toolCalls || [];

        if (!this._isGenerating) {
          // Generation was stopped mid-stream
          finalResponse = currentResponse;
          conversationHistory.push({ role: 'assistant', content: currentResponse });
          break;
        }

        // Strip <think>...</think> blocks from reasoning models (deepseek-r1)
        currentResponse = currentResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        // Handle empty response (model produced nothing or only thinking). Note: native
        // function-calling models often legitimately return empty text content when they
        // have tool_calls instead — that's not a failure, so only nudge-retry when there's
        // no text AND no native tool call to fall back on.
        if ((!currentResponse || currentResponse.length < 2) && nativeToolCalls.length === 0) {
          console.warn(`[AgentCore] Empty response at iteration ${iteration}, retrying with nudge`);
          conversationHistory.push({
            role: 'assistant',
            content: '(thinking...)',
          });
          conversationHistory.push({
            role: 'user',
            content: 'Please proceed with the task. Start by listing the project files, then read the key files, and take action.',
          });
          continue; // retry
        }

        // Parse tool calls: prefer structured native tool_calls when the model returned
        // them; otherwise fall back to the markdown ```tool``` block convention.
        const toolCalls = nativeToolCalls.length > 0
          ? convertNativeToolCalls(nativeToolCalls)
          : parseToolCalls(currentResponse);

        // How many ```tool``` blocks the model attempted vs how many actually parsed —
        // only meaningful for the markdown convention (native tool_calls are already
        // structured, so there's nothing to fail to parse).
        const attemptedBlocks = nativeToolCalls.length > 0 ? toolCalls.length : countToolBlockAttempts(currentResponse);
        const malformedBlockCount = attemptedBlocks - toolCalls.length;

        if (toolCalls.length === 0) {
          if (malformedBlockCount > 0) {
            // The model clearly TRIED to call a tool (there's a ```tool``` block) but
            // the JSON was broken beyond what tryParseToolJSON's recovery strategies
            // could fix. Previously this silently vanished — the model would think its
            // tool call went through and the conversation would just stall. Instead,
            // tell it plainly and give it another turn to retry with valid JSON.
            console.warn(`[AgentCore] ${malformedBlockCount} unparseable tool block(s) at iteration ${iteration} — asking model to retry`);
            conversationHistory.push({ role: 'assistant', content: currentResponse });
            conversationHistory.push({
              role: 'user',
              content: `Your last message contained a \`\`\`tool\`\`\` block that could not be parsed as valid JSON, so nothing ran. ` +
                `Resend it as strict JSON on one line: {"tool": "name", "params": {...}}. ` +
                `Escape any newlines inside string values as \\n and any quotes as \\".`,
            });
            continue; // retry
          }
          // No tool calls attempted — we're done
          finalResponse = currentResponse;
          conversationHistory.push({ role: 'assistant', content: currentResponse });
          break;
        }

        // There are tool calls — add assistant message to history
        conversationHistory.push({ role: 'assistant', content: currentResponse });

        // Execute each tool call
        const availableTools = getAvailableToolNames();
        const toolResultParts = [];
        // Extra context passed as a 3rd arg to tool handlers. Most handlers ignore
        // whichever of these they don't need, so it's safe to pass all of them
        // uniformly: confirmRiskyCommand (run_command), ollamaClient/embedClient
        // (index_codebase, semantic_search — embeddings only make sense against the
        // local Ollama provider, so embedClient is null for cloud providers).
        const toolContext = {
          confirmRiskyCommand: onConfirmCommand,
          ollamaClient: this.ollamaClient,
          embedClient: this.provider === 'ollama' ? this.ollamaClient : null,
        };

        for (const call of toolCalls) {
          if (!this._isGenerating) break;

          // Emit tool status
          onStatus({ status: 'tool', message: `Running ${call.tool}...` });

          let result;

          if (!availableTools.includes(call.tool)) {
            result = `❌ Unknown tool: "${call.tool}". Available tools: ${availableTools.join(', ')}`;
          } else {
            const handler = tools[call.tool];
            try {
              result = await handler(call.params, projectFolder, toolContext);
            } catch (err) {
              result = `❌ Tool execution error (${call.tool}): ${err.message}`;
            }
          }

          const toolExecution = {
            tool: call.tool,
            params: call.params,
            result,
          };

          allToolResults.push(toolExecution);
          onToolExecution(toolExecution);

          toolResultParts.push(`[Tool Result: ${call.tool}]\n${result}`);
        }

        // If some (but not all) ```tool``` blocks in this response failed to parse,
        // the successfully-parsed ones above already ran — but silently dropping the
        // broken ones would look to the model like they succeeded too. Flag it explicitly.
        if (malformedBlockCount > 0) {
          toolResultParts.push(
            `[Note] ${malformedBlockCount} additional \`\`\`tool\`\`\` block(s) in your last message could not be parsed ` +
            `as valid JSON and did NOT run. If you still need them, resend as strict one-line JSON.`
          );
        }

        // Add tool results as a "user" message (simulating tool feedback to the LLM)
        // Some models expect tool results this way; we use a clear format
        const toolResultsMessage = toolResultParts.join('\n\n---\n\n');
        conversationHistory.push({
          role: 'user',
          content: `Tool results:\n${toolResultsMessage}\n\nContinue to the next step. If all steps are done, summarize what was accomplished.`,
        });

        // Continue the loop — the LLM will see the tool results and may generate more tool calls
        finalResponse = currentResponse;
      }

      this._isGenerating = false;
      onStatus({ status: 'idle', message: '' });

      return {
        response: finalResponse,
        toolResults: allToolResults,
      };
    } catch (err) {
      this._isGenerating = false;
      throw err;
    }
  }

  /**
   * Stop the current generation.
   */
  stopGeneration() {
    this._isGenerating = false;
    this.ollamaClient.abort();
  }

  /**
   * Check if the agent is currently generating a response.
   */
  get isGenerating() {
    return this._isGenerating;
  }
}

module.exports = AgentCore;

// Exposed for unit testing only (see test/core.test.js) — not part of the public API
// other modules should rely on.
module.exports._testUtils = {
  bucketNumCtx,
  estimateTokens,
  parseToolCalls,
  tryParseToolJSON,
  convertNativeToolCalls,
  stripToolBlocks,
  countToolBlockAttempts,
};
