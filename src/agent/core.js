'use strict';

const { getSystemPrompt, getAvailableToolNames } = require('./prompts');
const tools = require('./tools');

const MAX_TOOL_ITERATIONS = 15;  // Allow multi-step task execution

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
 * Strips tool call blocks from the response text to get the "plain" assistant message.
 */
function stripToolBlocks(responseText) {
  return responseText.replace(/```tool\s*\n[\s\S]*?```/g, '').trim();
}

class AgentCore {
  /**
   * @param {import('../ollama/client')} ollamaClient
   */
  constructor(ollamaClient) {
    if (!ollamaClient) {
      throw new Error('OllamaClient instance is required');
    }
    this.ollamaClient = ollamaClient;
    this._isGenerating = false;
    this._contextSizeCache = {};  // model → context_size cache
  }

  /**
   * Get the model's context window size (cached after first lookup).
   * Caps at 8192 to prevent massive KV cache allocation on local machines.
   */
  async _getContextSize(model) {
    if (this._contextSizeCache[model]) {
      return this._contextSizeCache[model];
    }
    const rawSize = await this.ollamaClient.getContextSize(model);
    // Cap at 16384 — balance between context space and performance
    const size = Math.min(rawSize, 16384);
    this._contextSizeCache[model] = size;
    console.log(`[AgentCore] Model "${model}" context: ${rawSize} (capped to ${size})`);
    return size;
  }

  /**
   * Build the messages array that fits within the model's context budget.
   * Strategy:
   *   1. Always include system prompt
   *   2. Reserve 40% of context for the model's response
   *   3. Fill remaining budget from newest conversation messages backward
   *   4. If a message is too large, truncate its content
   *   5. If older messages are dropped, inject a summary of completed work
   */
  _buildContextMessages(systemMessage, conversationHistory, contextSize) {
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

    // If messages were dropped, inject a progress summary so the model knows what happened
    if (droppedCount > 0) {
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
   * @returns {Promise<{response: string, toolResults: Array<{tool: string, params: object, result: string}>}>}
   */
  async processMessage(userMessage, model, conversationHistory, onToken = () => {}, onToolExecution = () => {}, projectFolder = null, onStatus = () => {}) {
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

      // Add user message to history
      conversationHistory.push({ role: 'user', content: enrichedMessage });

      // Build messages array with system prompt prepended (model-aware for security models)
      const systemMessage = { role: 'system', content: getSystemPrompt(projectFolder, model) };

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

        // Smart context: detect model's context window, build messages within budget
        const contextSize = await this._getContextSize(model);
        const messages = this._buildContextMessages(systemMessage, conversationHistory, contextSize);

        console.log(`[AgentCore] Iteration ${iteration}: ${messages.length} messages, ~${messages.reduce((s, m) => s + estimateTokens(m.content), 0)} tokens (budget: ${contextSize})`);

        // Stream the LLM response
        let currentResponse = '';
        let firstToken = false;
        let insideThinkBlock = false;

        currentResponse = await this.ollamaClient.chat(model, messages, (token) => {
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
          contextSize,
          onProgress: (progress) => {
            if (progress.event === 'progress') {
              onStatus({ status: 'generating', message: `Generating... ${progress.tokensPerSec} tok/s` });
            }
          },
        });

        if (!this._isGenerating) {
          // Generation was stopped mid-stream
          finalResponse = currentResponse;
          conversationHistory.push({ role: 'assistant', content: currentResponse });
          break;
        }

        // Strip <think>...</think> blocks from reasoning models (deepseek-r1)
        currentResponse = currentResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        // Handle empty response (model produced nothing or only thinking)
        if (!currentResponse || currentResponse.length < 2) {
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

        // Parse tool calls from the response
        const toolCalls = parseToolCalls(currentResponse);

        if (toolCalls.length === 0) {
          // No tool calls — we're done
          finalResponse = currentResponse;
          conversationHistory.push({ role: 'assistant', content: currentResponse });
          break;
        }

        // There are tool calls — add assistant message to history
        conversationHistory.push({ role: 'assistant', content: currentResponse });

        // Execute each tool call
        const availableTools = getAvailableToolNames();
        const toolResultParts = [];

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
              result = await handler(call.params, projectFolder);
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
