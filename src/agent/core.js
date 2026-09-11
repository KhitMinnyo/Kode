'use strict';

const { getSystemPrompt, getAvailableToolNames, supportsNativeToolCalling } = require('./prompts');
const tools = require('./tools');
const memory = require('./memory');
const plan = require('./plan');
const contextCache = require('./contextCache');
const embeddings = require('./embeddings');
const {
  IMAGE_TOKEN_ESTIMATE,
  textOf,
  imagePartsOf,
  buildContent,
  withText,
  toPlainText,
} = require('../shared/messageContent');
const { TOOL_SCHEMAS } = tools;

// Allow multi-step task execution. Bumped from 15: with write_plan encouraging explicit
// step tracking and git_checkpoint/git_revert making mistakes cheap to undo, longer
// multi-file tasks (the ones local models most need help staying on track for) were
// hitting the old ceiling before finishing. This is now the DEFAULT only — the live
// limit lives on each AgentCore instance (this.maxToolIterations), configurable from
// Settings so cloud models with a longer useful run don't get cut off mid-task.
const DEFAULT_MAX_TOOL_ITERATIONS = 25;

// How many times in a row processMessage will auto-nudge the model to keep going (or
// explicitly confirm it's done) instead of ending the turn — see the "stall" check
// below. The system prompt asks the model to persist through multi-step tasks on its
// own, but that's a request, not a guarantee: a model can still stop after doing real
// work without saying so, which is exactly what looked like "does a little, then
// stops" (the user had to send a follow-up before it would continue). This is the
// code-level backstop for that — bounded so a model that never says "done" can't spin
// the loop forever.
const MAX_STALL_NUDGES = 3;

// How many times processMessage will nudge a model that returned nothing at all —
// no text, no tool call — without the connection having stalled. This used to be
// unbounded: only the stalled variant was counted against MAX_STALL_NUDGES, and the
// plain-empty branch just retried. Each retry re-sends the ENTIRE conversation, so an
// unbudgeted loop here quietly burns a full context window per attempt, up to
// maxToolIterations (25) times — roughly two hours and a very large bill for a turn
// that was never going to finish. It stayed invisible for as long as it did because a
// genuine 5-minute stall was being mis-reported as an ordinary empty response (the
// abort path resolved instead of rejecting — see src/shared/streamGuards.js), so the
// stall budget above never applied to it.
const MAX_EMPTY_NUDGES = 3;

// How many times processMessage will nudge the model to fix a problem that automatic
// post-"Done" verification (_verifyDoneClaim below) actually found, before giving up
// and just reporting the problem instead of silently accepting the claim. Smaller than
// MAX_STALL_NUDGES: a stall is a connection hiccup worth retrying a few times, but a
// syntax error or failing test is a real defect — if the model can't fix it in a
// couple of tries, more retries are unlikely to help and just burn time/tokens.
const MAX_VERIFY_NUDGES = 2;

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
 * Rough token estimator — deliberately not a real per-model tokenizer. Kode talks to
 * many different model families (Ollama's local GGUF models, DeepSeek, OpenAI,
 * Anthropic, any OpenAI-compatible custom endpoint), each with its own tokenizer, so
 * even a "real" tokenizer (e.g. OpenAI's cl100k_base) would only be correct for ONE
 * of those providers and still wrong for the rest — while adding a 20MB+ dependency
 * bundled into every platform's installer just to be precise for a single provider.
 * This stays a calibrated heuristic on purpose.
 *
 * The old flat text.length/3.5 assumed every character costs the same ~3.5
 * chars/token, which is roughly right for ASCII English/code but badly wrong for
 * non-Latin scripts: BPE vocabularies are trained overwhelmingly on English/code
 * corpora, so non-ASCII text (Burmese, Chinese, Japanese, Korean, Thai, emoji, ...)
 * tokenizes far more densely — often close to 1 token per character once it falls
 * back to byte-level encoding, not 3.5 chars/token. A conversation in Burmese (this
 * app's own UI/support language for a chunk of its users) was having its real token
 * cost under-counted by roughly 3x, which could let _buildContextMessages's context
 * budget silently overflow well past what it thought it was requesting.
 */
function estimateTokens(text) {
  if (!text) return 0;
  const str = String(text);
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) < 128) asciiChars++;
    else nonAsciiChars++;
  }
  // ASCII (English prose, code, punctuation): same ~3.5 chars/token calibration as
  // before. Non-ASCII: ~1.2 chars/token, much closer to how BPE tokenizers actually
  // handle scripts they weren't heavily trained on.
  return Math.ceil(asciiChars / 3.5 + nonAsciiChars / 1.2);
}

/**
 * estimateTokens for a whole message's content, which since image attachments is no
 * longer always a string: a message can be an array of text/image parts (see
 * src/shared/messageContent.js). Text is estimated as before; each image adds a flat
 * allowance, because an image's real context cost is invisible to a character count —
 * left uncounted, a couple of screenshots would silently eat a context budget that
 * _buildContextMessages believed it was respecting.
 */
function estimateMessageTokens(content) {
  if (typeof content === 'string') return estimateTokens(content);
  return estimateTokens(textOf(content)) + imagePartsOf(content).length * IMAGE_TOKEN_ESTIMATE;
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
  constructor(ollamaClient, maxContextCap = 16384, provider = 'ollama', maxToolIterations = DEFAULT_MAX_TOOL_ITERATIONS) {
    if (!ollamaClient) {
      throw new Error('OllamaClient instance is required');
    }
    this.ollamaClient = ollamaClient;
    // Per-turn safety limit on how many model↔tool round-trips this agent will run
    // before cutting the turn off (see the cutoff message after the loop below).
    // Configurable from Settings — setMaxToolIterations() mirrors setMaxContextCap().
    this.maxToolIterations = this._sanitizeMaxToolIterations(maxToolIterations);
    this._isGenerating = false;
    // AbortController for whatever tool call is currently in flight (run_command,
    // run_tests) — see stopGeneration() below. A separate concern from
    // this.ollamaClient.abort(), which only cancels the model's own request; without
    // this, hitting Stop while a shell command was running couldn't do anything until
    // that command's own (much longer) timeout elapsed on its own.
    this._toolAbortController = null;
    this._contextSizeCache = {};  // model → context_size cache
    this.maxContextCap = maxContextCap; // user-configurable ceiling, see setMaxContextCap()
    this._contextSummaryCache = {};  // conversation fingerprint → { droppedCount, summary }
    this._projectScanCache = {};     // projectFolder → { fingerprint, context } (see _scanProjectContext)
    // Which backend `this.ollamaClient` currently points at: 'ollama' | 'deepseek' |
    // 'openai' | 'anthropic'. Despite the property name (kept for backward
    // compatibility), it holds whichever client main.js's getActiveClient() selected.
    this.provider = provider;
    // API keys for the two tools that call third-party services directly
    // (firecrawl_scrape, web_search) rather than through the active LLM provider —
    // set from Settings via setToolApiKeys(), independent of provider/model. Default
    // to '' (not undefined) so toolContext always has a defined value even before
    // main.js configures one; tools.js falls back to the matching env var when empty.
    this.firecrawlApiKey = '';
    this.braveSearchApiKey = '';
  }

  /**
   * Update the API keys used by tools that call third-party services directly
   * (firecrawl_scrape → Firecrawl, web_search → Brave Search). Call this any time
   * main.js's Settings change, same as setMaxContextCap — unlike the LLM provider
   * these aren't tied to which client this.ollamaClient currently points at, so they
   * don't require recreating the AgentCore.
   * @param {{firecrawlApiKey?: string, braveSearchApiKey?: string}} keys
   */
  setToolApiKeys(keys = {}) {
    if (typeof keys.firecrawlApiKey === 'string') this.firecrawlApiKey = keys.firecrawlApiKey;
    if (typeof keys.braveSearchApiKey === 'string') this.braveSearchApiKey = keys.braveSearchApiKey;
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

  /** Coerce a raw max-tool-iterations value into a sane in-range integer. */
  _sanitizeMaxToolIterations(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_MAX_TOOL_ITERATIONS;
    // Keep it bounded: min 1 (never allow an infinite loop), max 500 (plenty for any
    // real multi-step task while still guaranteeing the turn eventually terminates).
    return Math.min(500, Math.max(1, parsed));
  }

  /**
   * Update the per-turn tool-iteration limit (from Settings). Unlike maxContextCap this
   * applies to ALL providers — cloud models are exactly the ones that most often need a
   * higher limit to finish a long multi-file task without being cut off at the default.
   */
  setMaxToolIterations(maxToolIterations) {
    this.maxToolIterations = this._sanitizeMaxToolIterations(maxToolIterations);
    console.log(`[AgentCore] Max tool iterations set to ${this.maxToolIterations}`);
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
   * Best-effort: saves the full (untruncated) text of conversation history messages
   * that are about to be dropped from the live context to a scratch file, so the
   * exact detail isn't purely lost once _summarizeDroppedHistory's LLM paraphrase (or
   * the cheap tool-names-only fallback below) replaces it in what's actually sent to
   * the model. A long multi-step task can drop many KB of tool output (file contents,
   * command/scan results) as context fills up — that output already did its job
   * informing the step it was used in, but if a LATER step needs the exact original
   * text again (not just "ran nmap, found 3 open ports"), a summary alone can't
   * provide that back. Only saves when there's enough content to be worth a file —
   * most individual drops are small back-and-forth that summarizes losslessly enough
   * on its own, and creating a scratch file for every trivial drop would just be
   * clutter nobody reads.
   * @returns {string} a note to append to the summary pointing at the saved file, or
   *   '' if nothing was saved (too small, no project folder, or the write failed).
   */
  _cacheDroppedHistoryToScratch(projectFolder, fullText) {
    const SCRATCH_MIN_SIZE = 1500;
    if (!projectFolder || !fullText || fullText.length < SCRATCH_MIN_SIZE) return '';
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(projectFolder, '.kode', 'scratch');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `${stamp}-dropped-history.txt`;
      fs.writeFileSync(path.join(dir, fileName), fullText, 'utf-8');
      return ` (Full detail of these trimmed messages was saved to .kode/scratch/${fileName} — read_file it with offset/limit if the exact original output is needed again.)`;
    } catch (err) {
      console.warn('[AgentCore] Failed to cache dropped history to scratch:', err.message);
      return '';
    }
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
  async _buildContextMessages(systemMessage, conversationHistory, contextSize, model, projectFolder) {
    const systemTokens = estimateTokens(systemMessage.content);
    const responseReserve = Math.floor(contextSize * 0.4);  // 40% for response
    let budget = contextSize - systemTokens - responseReserve;

    if (budget < 200) budget = 200; // absolute minimum

    // Walk backward through history, adding messages until budget runs out
    const selectedMessages = [];
    let droppedCount = 0;

    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const msg = conversationHistory[i];
      let msgTokens = estimateMessageTokens(msg.content);

      if (msgTokens > budget) {
        // If this is the most recent message (must include), truncate it. The old
        // flat `budget * 3.5` assumed every character is ASCII (~3.5 chars/token),
        // which is wrong for non-ASCII scripts — Burmese/CJK/emoji tokenize far more
        // densely (see estimateTokens) — and could let the truncated message still
        // overflow the budget. Binary-search the longest prefix that actually fits
        // per estimateTokens instead.
        if (selectedMessages.length === 0) {
          // Only the TEXT is truncated. Slicing multimodal content as if it were a
          // string would corrupt it (and half an image is worth nothing anyway), so
          // images are carried over whole and the text is trimmed around them.
          const text = textOf(msg.content);
          const imageAllowance = imagePartsOf(msg.content).length * IMAGE_TOKEN_ESTIMATE;
          const textBudget = Math.max(0, budget - imageAllowance);
          let lo = 0;
          let hi = text.length;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (estimateTokens(text.slice(0, mid)) > textBudget) hi = mid - 1;
            else lo = mid;
          }
          selectedMessages.unshift({
            role: msg.role,
            content: withText(msg.content, text.slice(0, lo) + '\n... (truncated)'),
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
      let cache = this._contextSummaryCache[fingerprint];
      if (!cache && projectFolder) {
        // In-memory cache misses on every fresh AgentCore instance (app restart, or a
        // new tab picking up an existing conversation) — check the on-disk cache
        // before paying for another LLM summarization call.
        const diskEntry = contextCache.getEntry(projectFolder, fingerprint);
        if (diskEntry) {
          cache = diskEntry;
          this._contextSummaryCache[fingerprint] = diskEntry; // warm it for next time
        }
      }
      // cache.scratchNote is stored separately from cache.summary (rather than baked
      // into it) so the rolling summary passed back into _summarizeDroppedHistory as
      // "previous summary" on the NEXT drop stays clean LLM-generated prose, while the
      // scratch-file pointer still gets reapplied on every reuse of this cached entry.
      let summaryText = cache && cache.droppedCount === droppedCount ? (cache.summary + (cache.scratchNote || '')) : null;
      let scratchNote = '';

      if (!summaryText) {
        const sinceIndex = cache ? cache.droppedCount : 0;
        const newlyDropped = conversationHistory.slice(sinceIndex, droppedCount);

        if (newlyDropped.length > 0) {
          const newlyDroppedFullText = newlyDropped.map(m => `[${m.role}] ${toPlainText(m.content)}`).join('\n');
          // Save the FULL text before it's lossily reduced below — see
          // _cacheDroppedHistoryToScratch's doc comment for why.
          scratchNote = this._cacheDroppedHistoryToScratch(projectFolder, newlyDroppedFullText);
          const newlyDroppedText = newlyDroppedFullText.slice(-3000); // bound the summarizer's own input regardless of how much was dropped at once

          const generated = await this._summarizeDroppedHistory(model, cache ? cache.summary : null, newlyDroppedText);
          if (generated) {
            summaryText = generated + scratchNote;
            const entry = { droppedCount, summary: generated, scratchNote };
            this._contextSummaryCache[fingerprint] = entry;
            if (projectFolder) contextCache.setEntry(projectFolder, fingerprint, entry);
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
        // out, or the model hasn't produced anything usable yet. Still gets the
        // scratch-file pointer if one was saved above, even though the LLM summary
        // itself didn't come through.
        const droppedMessages = conversationHistory.slice(0, droppedCount);
        const completedTools = [];
        for (const msg of droppedMessages) {
          const msgText = toPlainText(msg.content);
          if (msg.role === 'user' && msgText.startsWith('Tool results:')) {
            const toolMatches = msgText.match(/\[Tool Result: (\w+)\]/g);
            if (toolMatches) {
              toolMatches.forEach(m => completedTools.push(m.replace('[Tool Result: ', '').replace(']', '')));
            }
          }
        }

        if (completedTools.length > 0) {
          const summary = `[Context note: Earlier messages were trimmed. Previously completed: ${completedTools.join(', ')} (${completedTools.length} tool operations). Continue from where you left off.]${scratchNote}`;
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
   * Runs one turn's tool calls, executing consecutive read-only calls (see
   * tools.isReadOnlyToolCall) concurrently via Promise.all instead of one at a time —
   * a model that asks to read several files, grep, and check git status in the same
   * turn no longer pays for each one's latency serially. A batch boundary is drawn at
   * every side-effecting call (create_file, run_command, apply_patch, etc.): those
   * still run alone, so a write is never racing another call and anything after it
   * can rely on having seen its effect, exactly as before this method existed.
   *
   * Individual tool errors are caught per-call (same as the old sequential loop) so
   * one failing/throwing tool never takes down the rest of its batch. Results and
   * onToolExecution callbacks are emitted in the model's original request order once
   * each batch settles, regardless of which call in the batch actually finished
   * first — the model still sees "[Tool Result: x]" blocks in the order it asked for
   * them.
   *
   * Stop-responsiveness (`this._isGenerating`) is checked once per batch rather than
   * once per call — a minor regression for a large all-read-only batch, but read-only
   * tools are typically fast, and the tools that actually run long (run_command,
   * run_tests) are side-effecting and so already run alone, one per batch, where the
   * check still applies before each one.
   *
   * @returns {Promise<Array<{tool: string, params: object, result: string}>>}
   */
  async _executeToolCalls(toolCalls, projectFolder, toolContext, onStatus, onToolExecution) {
    const availableTools = getAvailableToolNames();
    const results = [];

    const runOne = async (call) => {
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
      return { tool: call.tool, params: call.params, result };
    };

    let i = 0;
    while (i < toolCalls.length) {
      if (!this._isGenerating) break;

      // Group this call with however many immediately-following calls are also
      // read-only, so e.g. three read_file calls in a row run concurrently. A
      // side-effecting call never grows a batch beyond itself.
      const batch = [toolCalls[i]];
      if (tools.isReadOnlyToolCall(toolCalls[i].tool, toolCalls[i].params)) {
        let j = i + 1;
        while (j < toolCalls.length && tools.isReadOnlyToolCall(toolCalls[j].tool, toolCalls[j].params)) {
          batch.push(toolCalls[j]);
          j++;
        }
      }

      onStatus(batch.length > 1
        ? { status: 'tool', message: `Running ${batch.length} tools in parallel: ${batch.map(c => c.tool).join(', ')}...` }
        : { status: 'tool', message: `Running ${batch[0].tool}...` });

      const batchResults = await Promise.all(batch.map(runOne));
      for (const toolExecution of batchResults) {
        results.push(toolExecution);
        onToolExecution(toolExecution);
      }

      i += batch.length;
    }

    return results;
  }

  /**
   * Re-verifies what this turn actually wrote to disk instead of trusting a "✅ Done"
   * claim at face value — see the call site in processMessage for why. Three checks,
   * cheapest first:
   *   0. A persisted write_plan (agent/plan.js) with any step still incomplete — the
   *      plan file only exists on disk while unfinished, so its mere presence is a
   *      direct sign the task isn't done. Runs regardless of whether any file was
   *      touched this turn (the other two checks below only run when one was).
   *   1. Re-run quickSyntaxCheck (tools.js) on every file this turn successfully
   *      created/edited/patched. Cheap (milliseconds), and catches the exact class of
   *      mistake local models make most (mismatched braces, bad escaping) even if the
   *      model glossed over the same note already appended to the tool result.
   *   2. If syntax is clean AND the project has a real `npm test` script (not the
   *      npm-init placeholder) AND at least one file was touched, run the actual test
   *      suite (bounded to at most MAX_VERIFY_NUDGES + 1 runs per turn — see the doc
   *      comment on the test-suite check below for why re-running isn't wasteful here).
   * @returns {Promise<string|null>} a description of the problem, or null if there's
   *   nothing to verify (no active plan, no files touched this turn) or everything
   *   checks out.
   */
  async _verifyDoneClaim(allToolResults, projectFolder) {
    if (!projectFolder) return null;
    const path = require('path');

    // Ground-truth check #0 (cheapest, and — unlike the syntax/test checks below —
    // independent of whether any files were touched THIS turn): a persisted plan
    // (agent/plan.js) only stays on disk while at least one of its steps is still
    // incomplete — write_plan clears the file the moment every step is marked done
    // (see write_plan in tools.js / plan.isPlanComplete). So a "✅ Done" claim while a
    // plan file still exists on disk is a direct, structural sign the task isn't
    // actually finished. This specifically catches the case the checks below can't:
    // a turn that claims done without creating/editing/patching any file this turn
    // (e.g. the model just stopped producing tool calls partway through a plan, or
    // only did non-file steps) — previously that fell straight through to
    // `touchedFiles.size === 0 return null` below with no verification at all.
    const activePlan = plan.loadPlan(projectFolder);
    if (activePlan) {
      const { text } = plan.formatPlan(activePlan.steps);
      return `Your own saved plan (write_plan) still shows unfinished steps:\n${text}\n\n` +
        `Either keep going and finish them now, or — if the plan is stale/no longer accurate — ` +
        `call write_plan again with the corrected steps before declaring the task done.`;
    }

    // Files this turn actually wrote successfully. A plain Q&A turn, or one that only
    // ran read-only tools (search_files, read_file, git_status, ...), has nothing here
    // — that's the common case, and this function returns null immediately for it.
    const touchedFiles = new Set();
    for (const t of allToolResults) {
      if (!t.result || typeof t.result !== 'string' || !t.result.startsWith('✅')) continue;
      if (t.tool === 'create_file' || t.tool === 'edit_file') {
        const p = t.params && t.params.path;
        if (p) touchedFiles.add(path.isAbsolute(p) ? p : path.join(projectFolder, p));
      } else if (t.tool === 'apply_patch') {
        // apply_patch's result is one line per file hunk: "✅ Created <path> (...)" or
        // "✅ Patched <path> (...)" — see tools.js.
        for (const line of t.result.split('\n')) {
          const m = line.match(/^✅ (?:Created|Patched) (\S+)/);
          if (m) touchedFiles.add(path.isAbsolute(m[1]) ? m[1] : path.join(projectFolder, m[1]));
        }
      }
    }
    if (touchedFiles.size === 0) return null;

    const syntaxIssues = [];
    for (const filePath of touchedFiles) {
      const check = tools.quickSyntaxCheck(filePath);
      if (check && !check.ok) {
        syntaxIssues.push(`${path.relative(projectFolder, filePath)}: ${check.error}`);
      }
    }
    if (syntaxIssues.length > 0) {
      return `A syntax check on the file(s) you just wrote found a problem:\n${syntaxIssues.join('\n')}`;
    }

    // Unlike the syntax check, tests only need a real script to run against. Re-run
    // (rather than "once per turn") is deliberate: this point is only reached again
    // when a previous attempt actually failed and the loop nudged for a fix — a clean
    // pass falls straight through to acceptance below with no further looping — so
    // it's naturally bounded to at most MAX_VERIFY_NUDGES + 1 runs per turn, and it's
    // the only way to confirm the model's fix attempt actually worked rather than
    // trusting a repeated "✅ Done" claim on faith.
    if (this._hasRealTestScript(projectFolder)) {
      const testResult = await tools.run_tests({}, projectFolder, {});
      if (typeof testResult === 'string' && testResult.startsWith('❌')) {
        return `The test suite failed after your changes:\n${testResult}`;
      }
    }

    return null;
  }

  /**
   * True when projectFolder has a package.json with a real `test` script — i.e. NOT
   * missing, and not npm init's default placeholder ("echo \"Error: no test
   * specified\" && exit 1"). Guards _verifyDoneClaim so it never invents test work
   * for a project that doesn't actually have a test suite.
   */
  _hasRealTestScript(projectFolder) {
    const fs = require('fs');
    const path = require('path');
    try {
      const pkgPath = path.join(projectFolder, 'package.json');
      if (!fs.existsSync(pkgPath)) return false;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const testScript = pkg.scripts && pkg.scripts.test;
      if (!testScript || typeof testScript !== 'string') return false;
      return !/Error:\s*no test specified/i.test(testScript);
    } catch {
      return false;
    }
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
      // Cheap fingerprint of the top-level tree (names + mtimes) so a project-level
      // request only actually re-reads files when something changed — a plain "what's
      // next / continue" on an unchanged project reuses the cached scan instead of
      // re-listing and re-reading the same files every single turn.
      const fingerprint = this._projectScanFingerprint(projectFolder, fs, path);
      if (fingerprint) {
        const cached = this._projectScanCache[projectFolder];
        if (cached && cached.fingerprint === fingerprint) {
          console.log('[AgentCore] Reusing cached project scan (unchanged).');
          return cached.context;
        }
      }

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

      if (fingerprint) {
        this._projectScanCache[projectFolder] = { fingerprint, context };
      }

      // Persist a compact structure note to long-term memory so a FUTURE session can
      // recall the layout instead of re-scanning from scratch. Only runs when the scan
      // actually changed (fingerprint mismatch above), so it never churns memory on
      // every message. Never blocks/fails the scan itself.
      await this._saveProjectScanToMemory(projectFolder, context);

      return context;
    } catch (err) {
      console.warn('[AgentCore] Failed to scan project:', err.message);
      return null;
    }
  }

  /**
   * Builds a cheap, stable fingerprint of a project folder's top-level entries (type +
   * name + mtime) so _scanProjectContext can tell "nothing changed, reuse the cached
   * scan" from "something changed, rescan". Skips dotfiles/node_modules, sorts for
   * stability, and returns null on any error (which just forces a rescan).
   */
  _projectScanFingerprint(projectFolder, fs, path) {
    try {
      const entries = fs.readdirSync(projectFolder, { withFileTypes: true });
      const parts = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        try {
          const stat = fs.statSync(path.join(projectFolder, entry.name));
          parts.push(`${entry.isDirectory() ? 'd' : 'f'}:${entry.name}:${Math.round(stat.mtimeMs)}`);
        } catch { /* skip entries we can't stat */ }
      }
      return parts.sort().join('|');
    } catch {
      return null;
    }
  }

  /**
   * Best-effort persistence of the current project scan into long-term memory under a
   * stable `project-structure` key. Mirrors save_memory's embedding behavior (embedding
   * only available on the Ollama provider) but never throws — losing this note just
   * means the next session re-scans, which is exactly what happened before, so it's a
   * pure improvement.
   */
  async _saveProjectScanToMemory(projectFolder, context) {
    try {
      const key = 'project-structure';
      let vector = null;
      const client = this.provider === 'ollama' ? this.ollamaClient : null;
      if (client && typeof client.embed === 'function') {
        try {
          const [computed] = await client.embed(embeddings.DEFAULT_EMBED_MODEL, [`${key} ${context}`]);
          if (Array.isArray(computed)) vector = computed;
        } catch (err) {
          console.warn('[AgentCore] Failed to embed project scan, saving without a vector:', err.message);
        }
      }
      memory.upsertMemoryEntry(projectFolder, key, context, ['project-analysis'], vector);
    } catch (err) {
      console.warn('[AgentCore] Failed to persist project scan to memory:', err.message);
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
   * @param {?function(string, string[]): (string|null|Promise<string|null>)} onAskUser - Called with
   *   (question, options) when the model calls the ask_user tool to pause the turn on a genuine
   *   blocker; should resolve to the user's answer (a string), or null if nobody answered in time.
   *   Pass null (or omit) when there's no UI to ask through — ask_user then reports itself
   *   unavailable rather than hanging, so the model falls back to its own best judgment. See
   *   src/agent/tools.js's ask_user and main.js's makeAskUserCallback.
   * @returns {Promise<{response: string, toolResults: Array<{tool: string, params: object, result: string}>, hitIterationCeiling: boolean}>}
   */
  async processMessage(userMessage, model, conversationHistory, onToken = () => {}, onToolExecution = () => {}, projectFolder = null, onStatus = () => {}, onConfirmCommand = null, onAskUser = null, images = []) {
    if (!userMessage || typeof userMessage !== 'string') {
      throw new Error('User message is required');
    }
    if (!model || typeof model !== 'string') {
      throw new Error('Model name is required');
    }

    this._isGenerating = true;
    this._toolAbortController = new AbortController();
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
          // Meaning-first recall: prefer embedding/semantic search (which catches
          // rephrasings and non-Latin queries like Burmese that keyword overlap misses),
          // then fall back to keyword overlap. Only injects when something actually
          // matches, so it doesn't add noise to every single message.
          let recalled = [];
          const client = this.provider === 'ollama' ? this.ollamaClient : null;
          if (client && typeof client.embed === 'function' && userMessage.trim()) {
            try {
              recalled = await memory.semanticSearchMemory(projectFolder, client, userMessage, 5);
            } catch (err) {
              console.warn('[AgentCore] Semantic auto-recall failed, falling back to keyword:', err.message);
            }
          }
          if (recalled.length === 0) {
            recalled = memory.searchMemory(projectFolder, userMessage, 3);
          }
          if (recalled.length > 0) {
            enrichedMessage = `${enrichedMessage}\n\n[Relevant project memory — recalled automatically]\n${memory.formatMemoryEntries(recalled)}`;
            console.log(`[AgentCore] Auto-recalled ${recalled.length} memory entr${recalled.length === 1 ? 'y' : 'ies'}`);
          }
        } catch (err) {
          console.warn('[AgentCore] Memory auto-recall failed:', err.message);
        }
      }

      // Add user message to history.
      //
      // With images attached (a pasted screenshot, a dropped PNG) the content becomes
      // a provider-neutral array of text/image parts instead of a plain string; each
      // client converts that to its own wire shape on the way out. Without images it
      // stays exactly the string it has always been, so nothing changes for a
      // text-only turn. Note the enrichment above (project context, memory recall)
      // applies to the TEXT part — the image travels alongside it, not inside it.
      const attachedImages = Array.isArray(images) ? images : [];
      conversationHistory.push({ role: 'user', content: buildContent(enrichedMessage, attachedImages) });
      if (attachedImages.length > 0) {
        console.log(`[AgentCore] Attached ${attachedImages.length} image(s) to this turn`);
      }

      // Build messages array with system prompt prepended (model-aware for security
      // models, and message-aware so the large pentest/red-team playbook is only
      // included when this task actually looks security-related — see prompts.js).
      const systemMessage = { role: 'system', content: getSystemPrompt(projectFolder, model, userMessage) };

      let iteration = 0;
      let finalResponse = '';
      let consecutiveStalls = 0; // see MAX_STALL_NUDGES
      let consecutiveEmpties = 0; // see MAX_EMPTY_NUDGES
      let consecutiveVerifyFails = 0; // see MAX_VERIFY_NUDGES / _verifyDoneClaim
      // Set true at every deliberate exit from the loop below (task done, user Stop,
      // stall budget exhausted). If the loop instead runs out of this.maxToolIterations
      // while this is still false, the task was cut off mid-progress, not finished or
      // abandoned — see the check right after the loop.
      let endedWithReason = false;

      while (iteration < this.maxToolIterations) {
        iteration++;

        if (!this._isGenerating) {
          endedWithReason = true;
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
        const messages = await this._buildContextMessages(systemMessage, conversationHistory, maxContextSize, model, projectFolder);

        // Right-size num_ctx to what this request actually needs instead of always
        // requesting the model's full (capped) window — smaller KV cache, faster prompt
        // processing, less RAM/VRAM pressure on local hardware.
        const neededTokens = messages.reduce((s, m) => s + estimateMessageTokens(m.content), 0);
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
            } else if (progress.event === 'reasoning') {
              // A reasoning model can think for minutes before its first answer token,
              // and its thinking never reaches onToken. Without this the header sat on
              // one status line with a climbing clock and a frozen token count for the
              // whole time — indistinguishable from a hang, which is what sent us
              // looking for a bug that wasn't there. See the reasoning-delta handling
              // in the provider clients.
              const secs = Math.round((progress.elapsed || 0) / 1000);
              onStatus({ status: 'thinking', message: `Thinking... (~${progress.tokens} reasoning tokens, ${secs}s)` });
            }
          },
        });

        currentResponse = chatResult.text;
        const nativeToolCalls = chatResult.toolCalls || [];

        if (!this._isGenerating) {
          // Generation was stopped mid-stream — a deliberate user action (Stop button),
          // not the connection going silent on its own. Labeled distinctly from the
          // stall give-up messages above/below so the transcript makes clear WHY the
          // turn ended short: stopped-by-you vs. stalled-and-gave-up look identical
          // otherwise (both are a truncated response with no tool calls).
          finalResponse = (currentResponse ? currentResponse + '\n\n' : '') + '⏹️ Stopped.';
          conversationHistory.push({ role: 'assistant', content: finalResponse });
          endedWithReason = true;
          break;
        }

        // Strip <think>...</think> blocks from reasoning models (deepseek-r1)
        currentResponse = currentResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        // Handle empty response (model produced nothing or only thinking). Note: native
        // function-calling models often legitimately return empty text content when they
        // have tool_calls instead — that's not a failure, so only nudge-retry when there's
        // no text AND no native tool call to fall back on.
        if ((!currentResponse || currentResponse.length < 2) && nativeToolCalls.length === 0) {
          // A stalled connection (client's 5min stall timeout) can also land here with
          // empty text — that's not the same as the model simply producing nothing on
          // its own, and retrying it forever would just burn through this.maxToolIterations
          // silently. Count it against the same stall budget as the "stopped mid-task"
          // nudges below, and give up with a clear message once that budget is spent.
          const stalledEmpty = chatResult.stalled === true;
          if (stalledEmpty && consecutiveStalls >= MAX_STALL_NUDGES) {
            finalResponse = `⚠️ The connection stalled repeatedly (${MAX_STALL_NUDGES} attempts) before the model produced a response. Try again, or check your connection or model.`;
            conversationHistory.push({ role: 'assistant', content: finalResponse });
            endedWithReason = true;
            break;
          }
          // The same ceiling for a model that simply keeps returning nothing. See
          // MAX_EMPTY_NUDGES for why an unbudgeted retry here is so expensive.
          if (!stalledEmpty && consecutiveEmpties >= MAX_EMPTY_NUDGES) {
            finalResponse = `⚠️ The model returned an empty response ${MAX_EMPTY_NUDGES} times in a row, so I stopped rather than keep re-sending the whole conversation. Try again, or switch to a different model.`;
            conversationHistory.push({ role: 'assistant', content: finalResponse });
            endedWithReason = true;
            break;
          }
          if (stalledEmpty) {
            consecutiveStalls++;
            console.warn(`[AgentCore] Stream stalled with no response at iteration ${iteration} (stall ${consecutiveStalls}/${MAX_STALL_NUDGES}), retrying with nudge`);
          } else {
            consecutiveEmpties++;
            console.warn(`[AgentCore] Empty response at iteration ${iteration} (empty ${consecutiveEmpties}/${MAX_EMPTY_NUDGES}), retrying with nudge`);
          }
          conversationHistory.push({
            role: 'assistant',
            content: '(thinking...)',
          });
          conversationHistory.push({
            role: 'user',
            content: stalledEmpty
              ? 'Your last response stalled before producing anything (connection issue). Please try again and proceed with the task.'
              : 'Please proceed with the task. Start by listing the project files, then read the key files, and take action.',
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
          // No tool calls attempted. If the model already did real work earlier THIS
          // turn (allToolResults.length > 0) but stopped without the explicit "✅ Done"
          // marker the system prompt asks for, don't just trust that it's actually
          // finished — a plain summary that quietly stops partway through a multi-step
          // task looks identical to one that's genuinely done. Nudge it to keep going
          // (or say so explicitly) instead of silently ending the turn on the model's
          // word alone. A simple direct answer with NO tool calls at all this turn
          // (allToolResults.length === 0 — ordinary Q&A, nothing to "finish") is exempt,
          // so this never forces tool use onto a plain conversational reply.
          //
          // This specifically matches "✅ Done" (the exact marker asked for above and in
          // the system prompt), not just any checkmark. A bare /✅/ test used to also match
          // an interim progress line like "✅ Fixed the CSS bug, checking the next one" —
          // the model's own habit of using ✅ to mark a completed SUB-step, not the whole
          // task — which counted as "done" and let the turn end silently mid-task even
          // though nothing was actually blocking it. That's the intermittent "stops before
          // the plan is finished" bug: it only happened on turns where the model's last
          // message happened to contain a checkmark for some other reason.
          const hasDoneMarker = /✅\s*done\b/i.test(currentResponse);
          // A stall-timeout abort (chatResult.stalled) can also land here: the client
          // gives back whatever partial text it had buffered (or none) with no tool
          // calls, which looks exactly like a legitimate finished answer unless we check
          // for it explicitly. Nudge on a stall even when allToolResults is still empty
          // (a stall can happen on the very first iteration, before any tool work) —
          // that's the one case the plain "no tool calls" exemption above must NOT apply to.
          const stalled = chatResult.stalled === true;
          if ((stalled || (allToolResults.length > 0 && !hasDoneMarker)) && consecutiveStalls < MAX_STALL_NUDGES) {
            consecutiveStalls++;
            console.warn(`[AgentCore] ${stalled ? 'Stream stalled' : 'Stopped without a "✅ Done" marker'} (stall ${consecutiveStalls}/${MAX_STALL_NUDGES}) — nudging to continue or confirm.`);
            conversationHistory.push({ role: 'assistant', content: currentResponse });
            conversationHistory.push({
              role: 'user',
              content: stalled
                ? `Your last response was cut off by a stalled connection. Please continue from where you left off and keep going with the task.`
                : `You stopped without saying "✅ Done:" — is the task actually finished? If there's more to do, keep going right now and call the next tool yourself — don't wait for me to ask. If it's genuinely complete, say so explicitly starting with "✅ Done:" and summarize what changed.`,
            });
            continue; // retry
          }

          // Stall nudges exhausted and this was still a genuine stall (not just a
          // missing "✅ Done" marker) — give up plainly instead of quietly presenting a
          // cut-off/garbled partial response as if it were the model's real, complete
          // answer.
          if (stalled) {
            finalResponse = (currentResponse ? currentResponse + '\n\n' : '') +
              `⚠️ The connection kept stalling after ${MAX_STALL_NUDGES} retries. This response may be incomplete — try again, or check your connection or model.`;
            conversationHistory.push({ role: 'assistant', content: finalResponse });
            endedWithReason = true;
            break;
          }

          // No tool calls attempted and the model believes the task is finished. Before
          // trusting that at face value, force a verification pass on whatever this turn
          // actually wrote to disk — a model saying "✅ Done" is not the same as the
          // result being correct, and the per-file quickSyntaxCheck note already
          // appended to each create_file/edit_file/apply_patch result (see tools.js) is
          // easy to see in the tool log and still walk right past. Only fires when there
          // is something to verify (hasDoneMarker, i.e. this is an actual completion
          // claim, not just a plain Q&A reply with nothing to check).
          if (hasDoneMarker) {
            const verifyIssue = await this._verifyDoneClaim(allToolResults, projectFolder);
            if (verifyIssue) {
              if (consecutiveVerifyFails < MAX_VERIFY_NUDGES) {
                consecutiveVerifyFails++;
                console.warn(`[AgentCore] Verification found a problem after "✅ Done" (attempt ${consecutiveVerifyFails}/${MAX_VERIFY_NUDGES}) — nudging to fix it.`);
                conversationHistory.push({ role: 'assistant', content: currentResponse });
                conversationHistory.push({
                  role: 'user',
                  content: `Hold on — before that's actually done:\n${verifyIssue}\n\nFix it, then confirm again.`,
                });
                continue; // retry
              }
              // Nudge budget exhausted — report the problem plainly rather than quietly
              // accepting a claim that automatic verification already disproved.
              finalResponse = currentResponse +
                `\n\n⚠️ Automatic verification still found a problem after ${MAX_VERIFY_NUDGES} attempt(s) to fix it:\n${verifyIssue}`;
              conversationHistory.push({ role: 'assistant', content: finalResponse });
              endedWithReason = true;
              break;
            }
          }

          // No tool calls attempted — we're done
          finalResponse = currentResponse;
          conversationHistory.push({ role: 'assistant', content: currentResponse });
          endedWithReason = true;
          break;
        }

        // There are tool calls — real progress happened, so reset the stall counter.
        consecutiveStalls = 0;
        consecutiveEmpties = 0;
        consecutiveVerifyFails = 0;

        // There are tool calls — add assistant message to history
        conversationHistory.push({ role: 'assistant', content: currentResponse });

        // Execute each tool call
        const toolResultParts = [];
        // Extra context passed as a 3rd arg to tool handlers. Most handlers ignore
        // whichever of these they don't need, so it's safe to pass all of them
        // uniformly: confirmRiskyCommand (run_command), ollamaClient/embedClient
        // (index_codebase, semantic_search — embeddings only make sense against the
        // local Ollama provider, so embedClient is null for cloud providers), signal
        // (run_command/run_tests — lets Stop kill an in-flight shell command instead
        // of only cancelling the model's own request), firecrawlApiKey/braveSearchApiKey
        // (firecrawl_scrape/web_search — set via setToolApiKeys() from Settings; those
        // tools fall back to FIRECRAWL_API_KEY/BRAVE_SEARCH_API_KEY env vars if empty).
        const toolContext = {
          confirmRiskyCommand: onConfirmCommand,
          askUser: onAskUser,
          ollamaClient: this.ollamaClient,
          embedClient: this.provider === 'ollama' ? this.ollamaClient : null,
          signal: this._toolAbortController.signal,
          firecrawlApiKey: this.firecrawlApiKey,
          braveSearchApiKey: this.braveSearchApiKey,
        };

        const batchResults = await this._executeToolCalls(toolCalls, projectFolder, toolContext, onStatus, onToolExecution);
        for (const toolExecution of batchResults) {
          allToolResults.push(toolExecution);
          toolResultParts.push(`[Tool Result: ${toolExecution.tool}]\n${toolExecution.result}`);
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
          content: `Tool results:\n${toolResultsMessage}\n\nIn one short line, say what that step accomplished, then immediately continue to the next step — don't stop to ask if you should keep going. Only stop if you're genuinely blocked and need something from the user. If the entire task is now fully done, say so explicitly: start your final line with "✅ Done:" and summarize what changed.`,
        });

        // Continue the loop — the LLM will see the tool results and may generate more tool calls
        finalResponse = currentResponse;
      }

      // The loop can only reach here without endedWithReason set by running out of
      // this.maxToolIterations while the model was still actively making tool-call
      // progress each iteration (never hit a stop/done/stall-exhausted branch above).
      // Previously this silently returned the last "did X, moving on" one-liner as if
      // it were the finished answer — indistinguishable from the task actually being
      // done. Say plainly that it was cut off by the safety limit instead.
      if (!endedWithReason) {
        finalResponse = (finalResponse ? finalResponse + '\n\n' : '') +
          `⚠️ Stopped after ${this.maxToolIterations} steps in a single turn (safety limit) — the task may not be fully finished. Ask me to continue and I'll pick up from here.`;
        conversationHistory.push({ role: 'assistant', content: finalResponse });
      }

      this._isGenerating = false;
      this._toolAbortController = null;
      onStatus({ status: 'idle', message: '' });

      return {
        response: finalResponse,
        toolResults: allToolResults,
        // True only when the loop above exited by running out of
        // this.maxToolIterations while the model was still actively making progress
        // every iteration (the exact !endedWithReason case right above) — NOT set for
        // a genuinely finished task, a user Stop, or a stall/connection give-up (all
        // of those set endedWithReason themselves). Lets a caller (see main.js's
        // stream-end payload and app.js's auto-continue) distinguish "cut off mid-task
        // by the safety limit" from every other reason a turn can end, instead of
        // pattern-matching the human-readable message text above.
        hitIterationCeiling: !endedWithReason,
      };
    } catch (err) {
      this._isGenerating = false;
      this._toolAbortController = null;
      throw err;
    }
  }

  /**
   * Stop the current generation. Cancels both the model's own request (via
   * ollamaClient.abort()) and, if a shell command is currently running (run_command,
   * run_tests), kills it immediately instead of leaving it to run out its own —
   * much longer — timeout. See runShellCommandAsync in agent/tools.js.
   */
  stopGeneration() {
    this._isGenerating = false;
    this.ollamaClient.abort();
    if (this._toolAbortController) {
      try { this._toolAbortController.abort(); } catch { /* already aborted */ }
    }
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
  estimateMessageTokens,
  parseToolCalls,
  tryParseToolJSON,
  convertNativeToolCalls,
  stripToolBlocks,
  countToolBlockAttempts,
};
