'use strict';

const https = require('https');

const { textOf } = require('../shared/messageContent');

const {
  MAX_TIME_TO_FIRST_OUTPUT,
  REASONING_REPORT_INTERVAL,
  CHARS_PER_TOKEN,
  guardStreamingRequest,
  armFirstOutputDeadline,
} = require('../shared/streamGuards');

const DEFAULT_TIMEOUT = 30000;
const ANTHROPIC_VERSION = '2023-06-01'; // dated API version header; bump if Anthropic requires a newer one

// Fallback model list used only if the live /v1/models call fails (e.g. API version
// mismatch or network issue) — these are the current Claude model strings as of this
// build; the live endpoint is authoritative whenever it's reachable.
const FALLBACK_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1'];

// Max context window differs across current Claude models: Haiku 4.5 is capped at
// 200K, while every other current model (Opus 5, Sonnet 5, Fable 5.1) supports the
// full 1M window. Previously this was hardcoded to a flat 200000 for every model,
// which silently throttled _buildContextMessages's history budget (agent/core.js) to
// 1/5th of what Opus 5/Sonnet 5/Fable 5.1 actually support — trimming/summarizing
// conversation history far more aggressively than necessary on a multi-step task.
const CONTEXT_SIZES = { 'claude-haiku-4-5-20251001': 200000 };
const DEFAULT_CONTEXT_SIZE = 1000000; // Opus 5 / Sonnet 5 / Fable 5.1 and any newer model

class AnthropicClient {
  constructor(apiKey = '') {
    this.apiKey = apiKey;
    this._abortController = null;
    // Set right before calling abort() on the current request, so the catch block
    // below (and callers) can tell a stall-triggered abort apart from the user
    // clicking Stop — both ultimately call the same AbortController.
    this._abortReason = null;
  }

  updateApiKey(newKey) {
    this.apiKey = newKey || '';
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

  _request(method, urlPath, body = null, { timeout = DEFAULT_TIMEOUT, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      const options = { hostname: 'api.anthropic.com', port: 443, path: urlPath, method, headers: this._headers(), timeout };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', (err) => reject(err));
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => { req.destroy(); reject(new Error(`Request to ${urlPath} timed out after ${timeout}ms`)); });

      if (signal) {
        if (signal.aborted) { req.destroy(); reject(new Error('Request aborted')); return; }
        signal.addEventListener('abort', () => { req.destroy(); reject(new Error('Request aborted')); }, { once: true });
      }

      if (body !== null) {
        const payload = JSON.stringify(body);
        req.setHeader('Content-Length', Buffer.byteLength(payload));
        req.write(payload);
      }
      req.end();
    });
  }

  _streamRequest(method, urlPath, body, onData, { signal = null } = {}) {
    return new Promise((resolve, reject) => {
      const options = { hostname: 'api.anthropic.com', port: 443, path: urlPath, method, headers: { ...this._headers(), 'Accept': 'text/event-stream' } };

      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const errorBody = Buffer.concat(chunks).toString('utf-8');
            let errorMsg;
            try {
              const parsed = JSON.parse(errorBody);
              errorMsg = parsed.error?.message || parsed.error || errorBody;
            } catch {
              errorMsg = errorBody;
            }
            const err = new Error(`Anthropic API error (${res.statusCode}): ${errorMsg}`);
            err.statusCode = res.statusCode;
            err.retryAfter = res.headers['retry-after'];
            reject(err);
          });
          return;
        }

        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            // Anthropic sends both "event: <type>" and "data: {...}" lines per event;
            // the payload's own `type` field already tells us what it is, so we only
            // need to parse the data lines.
            if (!trimmed.startsWith('data: ')) continue;
            try {
              onData(JSON.parse(trimmed.slice(6)));
            } catch {
              console.warn('[AnthropicClient] Failed to parse SSE data:', trimmed);
            }
          }
        });

        res.on('end', () => resolve());
        res.on('error', (err) => reject(guard.mapError(err)));
      });

      // Socket inactivity timeout, TCP keepalive, abort wiring — and the error mapper
      // every rejection path below goes through. Rejecting on abort (instead of the
      // old silent resolve() on ECONNRESET) is what lets chat()'s catch tag the result
      // as stalled. See src/shared/streamGuards.js.
      const guard = guardStreamingRequest(req, { urlPath, signal });
      if (guard.aborted) { reject(guard.mapError(new Error('Request aborted'))); return; }

      req.on('error', (err) => reject(guard.mapError(err)));

      if (body !== null) {
        const payload = JSON.stringify(body);
        req.setHeader('Content-Length', Buffer.byteLength(payload));
        req.write(payload);
      }
      req.end();
    });
  }

  /** Same 429-retry behavior as OpenAIClient — see its _streamRequestWithRetry for rationale. */
  async _streamRequestWithRetry(method, urlPath, body, onData, opts) {
    const MAX_RETRIES = 1;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._streamRequest(method, urlPath, body, onData, opts);
      } catch (err) {
        if (err.statusCode === 429 && attempt < MAX_RETRIES) {
          const waitMs = err.retryAfter ? parseInt(err.retryAfter, 10) * 1000 : 2000;
          console.warn(`[AnthropicClient] Rate limited (429) — retrying in ${waitMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        throw err;
      }
    }
  }

  async checkConnection() {
    if (!this.apiKey) return { connected: false, error: 'No API key configured' };
    try {
      // There's no cheap no-op endpoint, so a minimal 1-token message is the standard
      // way to validate a Claude API key without much cost.
      const res = await this._request('POST', '/v1/messages', {
        model: FALLBACK_MODELS[FALLBACK_MODELS.length - 1],
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }, { timeout: 15000 });
      if (res.statusCode === 200) return { connected: true };
      if (res.statusCode === 401) return { connected: false, error: 'Invalid API key' };
      if (res.statusCode === 404) return { connected: false, error: 'Model not found while validating key — key format looks checkable, but try again after picking a model' };
      return { connected: false, error: `Unexpected status code: ${res.statusCode}` };
    } catch (err) {
      return { connected: false, error: err.message };
    }
  }

  /**
   * List available Claude models. Falls back to a static list of known-current model
   * IDs if the live endpoint is unreachable or its response shape doesn't match.
   */
  async listModels() {
    try {
      const res = await this._request('GET', '/v1/models?limit=100', null, { timeout: 10000 });
      if (res.statusCode === 200) {
        const data = JSON.parse(res.body);
        if (Array.isArray(data.data) && data.data.length > 0) {
          return data.data.map((m) => ({
            name: m.id,
            size: 0,
            modified_at: m.created_at || '',
            details: { description: m.display_name || '' },
          }));
        }
      }
    } catch (err) {
      console.warn('[AnthropicClient] Live model list unavailable, using fallback:', err.message);
    }
    return FALLBACK_MODELS.map((id) => ({ name: id, size: 0, modified_at: '', details: {} }));
  }

  async getModelInfo(model) {
    return { name: model, details: { context_length: CONTEXT_SIZES[model] || DEFAULT_CONTEXT_SIZE } };
  }

  /** See the CONTEXT_SIZES comment above — Haiku 4.5 is 200K, everything else is 1M. */
  async getContextSize(model) {
    return CONTEXT_SIZES[model] || DEFAULT_CONTEXT_SIZE;
  }

  /**
   * Splits Kode's internal messages array (which always leads with one or more
   * role:'system' entries, per AgentCore's context-building logic) into Anthropic's
   * separate `system` string plus a user/assistant-only conversation array.
   */

  /**
   * Converts Kode's provider-neutral multimodal content into Anthropic's content
   * blocks: an image becomes a base64 `source` block rather than OpenAI's data-URL
   * `image_url`. Plain-string content — every text-only turn — passes through
   * untouched. See src/shared/messageContent.js.
   */
  _normalizeContent(content) {
    if (!Array.isArray(content)) return content;
    return content.map((part) => (
      part && part.type === 'image'
        ? { type: 'image', source: { type: 'base64', media_type: part.mediaType || 'image/png', data: part.data } }
        : { type: 'text', text: (part && part.text) || '' }
    ));
  }

  _splitSystemAndConversation(messages) {
    const systemParts = [];
    const conversation = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        // A system prompt is always plain text; textOf() keeps this safe if that ever
        // stops being true rather than stringifying an array into "[object Object]".
        systemParts.push(textOf(msg.content));
      } else {
        conversation.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: this._normalizeContent(msg.content),
        });
      }
    }
    return { system: systemParts.join('\n\n'), conversation };
  }

  /** Converts Kode's shared {type:'function', function:{name, description, parameters}} tool schemas into Anthropic's {name, description, input_schema} shape. */
  _convertTools(tools) {
    return tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  /**
   * @returns {Promise<{text: string, toolCalls: Array<object>}>}
   */
  async chat(model, messages, onChunk = () => {}, opts = {}) {
    if (!model || typeof model !== 'string') throw new Error('Model name is required');
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('Messages array is required and must not be empty');
    if (!this.apiKey) throw new Error('Anthropic API key is not configured. Please add your API key in Settings.');

    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    const { system, conversation } = this._splitSystemAndConversation(messages);

    let fullResponse = '';
    const startTime = Date.now();
    let firstTokenTime = null;
    let tokenCount = 0;
    const onProgress = opts.onProgress || (() => {});

    const requestBody = {
      model,
      system,
      messages: conversation,
      stream: true,
      // 4096 was needlessly small for an agent turn that writes real file content —
      // current Claude models support up to 128K output (64K for Haiku 4.5), no beta
      // header required. 32768 is safely under every current model's ceiling while
      // giving real headroom; this is a cap, not a target, so there's no cost to
      // setting it generously high — the model still stops on its own when done.
      max_tokens: opts.maxTokens || 32768,
      temperature: opts.temperature !== undefined ? opts.temperature : 0.7,
    };
    if (Array.isArray(opts.tools) && opts.tools.length > 0) {
      requestBody.tools = this._convertTools(opts.tools);
    }

    // Tool-use content blocks stream their `input` as incremental JSON-string
    // fragments (input_json_delta.partial_json) keyed by content-block index —
    // accumulate per index, same idea as OpenAI's tool_calls streaming.
    const toolBlocks = {}; // index -> { id, name, jsonBuffer }

    // Extended-thinking blocks stream before any answer text; these track them so the
    // UI can show the turn is alive (see the thinking_delta handler below).
    let reasoningChars = 0;
    let lastReasoningReport = 0;

    // Stall timeout: aborts if the model goes silent for this long — whether that's
    // before the first token, or in the middle of an otherwise-active stream (a
    // one-shot "first token" timeout that gets permanently disarmed after the first
    // chunk arrives leaves everything after that point completely unbounded). Re-armed
    // on every event received below.
    const STALL_TIMEOUT = 300000;
    let firstTokenTimeout = null;
    const armStallTimeout = () => {
      clearTimeout(firstTokenTimeout);
      firstTokenTimeout = setTimeout(() => {
        if (this._abortController) {
          this._abortReason = 'stall';
          this._abortController.abort();
        }
      }, STALL_TIMEOUT);
    };
    armStallTimeout();

    // armStallTimeout() above is re-armed by EVERY event, including ping events and
    // thinking deltas — traffic that carries no answer. This one-shot deadline is never
    // re-armed, so it bounds how long a request may run without producing a single
    // usable token or tool call.
    const outputDeadline = armFirstOutputDeadline(
      () => firstTokenTime !== null,
      () => {
        if (this._abortController) {
          console.warn(`[AnthropicClient] No output after ${MAX_TIME_TO_FIRST_OUTPUT / 1000}s (thinking/ping only) — aborting.`);
          this._abortReason = 'stall';
          this._abortController.abort();
        }
      },
    );

    try {
      await this._streamRequestWithRetry('POST', '/v1/messages', requestBody, (event) => {
        armStallTimeout();
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          toolBlocks[event.index] = { id: event.content_block.id, name: event.content_block.name, jsonBuffer: '' };
          if (!firstTokenTime) { firstTokenTime = Date.now(); clearTimeout(firstTokenTimeout); }
          return;
        }

        if (event.type === 'content_block_delta') {
          const delta = event.delta || {};
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            const token = delta.text;
            fullResponse += token;
            tokenCount++;
            if (!firstTokenTime) {
              firstTokenTime = Date.now();
              clearTimeout(firstTokenTimeout);
              onProgress({ event: 'first-token', elapsed: firstTokenTime - startTime });
            }
            onChunk(token);
            if (tokenCount % 20 === 0) {
              const elapsed = (Date.now() - firstTokenTime) / 1000;
              onProgress({ event: 'progress', tokens: tokenCount, tokensPerSec: elapsed > 0 ? parseFloat((tokenCount / elapsed).toFixed(1)) : 0 });
            }
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            // Extended thinking is not part of the model's answer, so it must not land
            // in fullResponse — and it deliberately does NOT set firstTokenTime, so the
            // first-output deadline above still applies to a model that only thinks.
            reasoningChars += delta.thinking.length;
            const now = Date.now();
            if (now - lastReasoningReport >= REASONING_REPORT_INTERVAL) {
              lastReasoningReport = now;
              onProgress({
                event: 'reasoning',
                tokens: Math.ceil(reasoningChars / CHARS_PER_TOKEN),
                elapsed: now - startTime,
              });
            }
          } else if (delta.type === 'input_json_delta' && toolBlocks[event.index]) {
            toolBlocks[event.index].jsonBuffer += delta.partial_json || '';
          }
          return;
        }

        if (event.type === 'message_stop') {
          clearTimeout(firstTokenTimeout);
          const totalTime = (Date.now() - startTime) / 1000;
          onProgress({ event: 'done', tokens: tokenCount, totalTime: parseFloat(totalTime.toFixed(1)) });
        }
      }, { signal });
    } catch (err) {
      clearTimeout(firstTokenTimeout);
      clearTimeout(outputDeadline);
      // err.aborted / err.timedOut are set by streamGuards.mapError. A dead connection
      // (timedOut) is a stall in every way that matters to the caller, so report it as
      // one instead of throwing an error the agent loop can only give up on.
      if (err.aborted || err.timedOut || err.message === 'Request aborted') {
        // A user-clicked Stop also lands here (same AbortController), but that path
        // never sets _abortReason to 'stall' — see abort() below — so `stalled` only
        // ever ends up true for an actual stall timeout, never a deliberate user stop.
        const stalled = this._abortReason === 'stall' || err.timedOut === true;
        if (!firstTokenTime) return { text: '⏱️ Model took too long to respond. Try a different model or simplify your request.', toolCalls: [], stalled };
        return { text: fullResponse, toolCalls: [], stalled };
      }
      throw err;
    } finally {
      clearTimeout(firstTokenTimeout);
      clearTimeout(outputDeadline);
      this._abortController = null;
      this._abortReason = null;
    }

    const toolCalls = Object.values(toolBlocks).map((b) => ({ function: { name: b.name, arguments: b.jsonBuffer } }));
    return { text: fullResponse, toolCalls, stalled: false };
  }

  abort() {
    if (this._abortController) {
      this._abortReason = 'user';
      this._abortController.abort();
      this._abortController = null;
    }
  }
}

module.exports = AnthropicClient;
