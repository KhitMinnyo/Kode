'use strict';

const https = require('https');
const http = require('http');

const {
  MAX_TIME_TO_FIRST_OUTPUT,
  REASONING_REPORT_INTERVAL,
  CHARS_PER_TOKEN,
  guardStreamingRequest,
  armFirstOutputDeadline,
} = require('../shared/streamGuards');

const DEFAULT_TIMEOUT = 30000;

// Safe generic fallback context window. Custom/self-hosted providers vary wildly
// (a local 8K llama.cpp server vs. a 128K+ hosted model on OpenRouter) and there's no
// common endpoint to auto-detect it, so it's user-tunable in Settings instead of
// guessed — see updateContextSize()/getContextSize().
const DEFAULT_CONTEXT_SIZE = 32768;

/**
 * Generic client for any OpenAI-compatible Chat Completions API — Groq, OpenRouter,
 * Together AI, Mistral, Fireworks, xAI, Perplexity, or a self-hosted server (LM
 * Studio, vLLM, llama.cpp server, text-generation-webui) — anything that speaks the
 * same POST /chat/completions (SSE streaming) + GET /models shape OpenAI does. This
 * lets Kode work with providers that don't have a dedicated client, without a code
 * change per provider.
 *
 * Two differences from OpenAIClient/DeepSeekClient (which hardcode their hostname):
 *   - The base URL (host + path prefix, e.g. "https://api.groq.com/openai/v1") is
 *     fully user-configured, and may be http:// for local servers.
 *   - The API key is optional — many self-hosted servers don't require one, so an
 *     Authorization header is only sent when a key is actually configured.
 */
class CustomClient {
  constructor(apiKey = '', baseUrl = '', contextSize = DEFAULT_CONTEXT_SIZE) {
    this.apiKey = apiKey;
    this._abortController = null;
    // Set right before calling abort() on the current request, so the catch block
    // below (and callers) can tell a stall-triggered abort apart from the user
    // clicking Stop — both ultimately call the same AbortController.
    this._abortReason = null;
    this.updateContextSize(contextSize);
    this.updateBaseUrl(baseUrl);
  }

  updateApiKey(newKey) {
    this.apiKey = newKey || '';
  }

  /** Update the assumed context window (from Settings) — see getContextSize(). */
  updateContextSize(newSize) {
    const parsed = parseInt(newSize, 10);
    this.contextSize = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_SIZE;
  }

  /**
   * Parses and stores the base URL (e.g. "https://api.groq.com/openai/v1" or
   * "http://localhost:1234/v1"). Trailing slashes are stripped so endpoint suffixes
   * can be appended directly ("/chat/completions", "/models"). An empty or malformed
   * URL leaves `this._parsedBase` null — every request method checks for that and
   * fails with a clear message rather than throwing deep inside Node's http/https.
   */
  updateBaseUrl(newBaseUrl) {
    this.baseUrl = (newBaseUrl || '').trim().replace(/\/+$/, '');
    this._parsedBase = null;
    if (!this.baseUrl) return;
    try {
      const parsed = new URL(this.baseUrl);
      const isHttp = parsed.protocol === 'http:';
      this._parsedBase = {
        transport: isHttp ? http : https,
        hostname: parsed.hostname,
        port: parsed.port || (isHttp ? 80 : 443),
        pathPrefix: parsed.pathname.replace(/\/+$/, ''), // e.g. "/openai/v1", or "" if none given
      };
    } catch (err) {
      console.warn('[CustomClient] Invalid base URL:', this.baseUrl, err.message);
      this._parsedBase = null;
    }
  }

  _headers(extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    // Only set Authorization when a key is actually configured — sending an empty
    // "Bearer " header confuses a few no-auth local servers.
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    return headers;
  }

  _request(method, urlPath, body = null, { timeout = DEFAULT_TIMEOUT, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      if (!this._parsedBase) {
        reject(new Error('Custom API base URL is not configured (or is invalid). Please set it in Settings.'));
        return;
      }
      const { transport, hostname, port, pathPrefix } = this._parsedBase;
      const options = {
        hostname,
        port,
        path: `${pathPrefix}${urlPath}`,
        method,
        headers: this._headers(),
        timeout,
      };

      const req = transport.request(options, (res) => {
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
      if (!this._parsedBase) {
        reject(new Error('Custom API base URL is not configured (or is invalid). Please set it in Settings.'));
        return;
      }
      const { transport, hostname, port, pathPrefix } = this._parsedBase;
      const options = {
        hostname,
        port,
        path: `${pathPrefix}${urlPath}`,
        method,
        headers: this._headers({ 'Accept': 'text/event-stream' }),
      };

      const req = transport.request(options, (res) => {
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
            const err = new Error(`Custom API error (${res.statusCode}): ${errorMsg}`);
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
            if (!trimmed.startsWith('data: ')) continue;
            const dataStr = trimmed.slice(6);
            if (dataStr === '[DONE]') continue;
            try {
              onData(JSON.parse(dataStr));
            } catch {
              console.warn('[CustomClient] Failed to parse SSE data:', dataStr);
            }
          }
        });

        res.on('end', () => resolve());
        res.on('error', (err) => reject(guard.mapError(err)));
      });

      // Socket inactivity timeout, TCP keepalive, abort wiring — and the error mapper
      // every rejection path below goes through. Rejecting on abort (instead of the
      // old silent resolve() on ECONNRESET) is what lets chat()'s catch tag the result
      // as stalled; without it a 5-minute stall came back looking like an ordinary
      // empty response. See src/shared/streamGuards.js.
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
          console.warn(`[CustomClient] Rate limited (429) — retrying in ${waitMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        throw err;
      }
    }
  }

  async checkConnection() {
    if (!this.baseUrl) return { connected: false, error: 'No base URL configured' };
    if (!this._parsedBase) return { connected: false, error: 'Invalid base URL' };
    try {
      const res = await this._request('GET', '/models', null, { timeout: 10000 });
      if (res.statusCode === 200) return { connected: true };
      if (res.statusCode === 401 || res.statusCode === 403) return { connected: false, error: 'Invalid API key' };
      return { connected: false, error: `Unexpected status code: ${res.statusCode}` };
    } catch (err) {
      return { connected: false, error: err.message };
    }
  }

  /**
   * List models via the standard OpenAI-shaped GET /models endpoint. Unlike
   * OpenAIClient, this does NOT filter by name pattern — custom providers name
   * models however they like (e.g. "meta-llama/Llama-3.1-70b-instruct" on
   * OpenRouter), so a client-side "looks like a chat model" heuristic would just as
   * often hide the model the user actually wants.
   */
  async listModels() {
    const res = await this._request('GET', '/models', null, { timeout: 10000 });
    if (res.statusCode !== 200) {
      throw new Error(`Failed to list models: HTTP ${res.statusCode}`);
    }
    const data = JSON.parse(res.body);
    const all = Array.isArray(data.data) ? data.data : [];
    return all
      .map((m) => ({ name: m.id, size: 0, modified_at: m.created ? new Date(m.created * 1000).toISOString() : '', details: {} }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getModelInfo(model) {
    return { name: model, details: { context_length: this.contextSize } };
  }

  /** Providers vary wildly and aren't auto-detectable; uses the Settings-configured value. */
  async getContextSize() {
    return this.contextSize;
  }

  /**
   * @returns {Promise<{text: string, toolCalls: Array<object>}>}
   */
  async chat(model, messages, onChunk = () => {}, opts = {}) {
    if (!model || typeof model !== 'string') throw new Error('Model name is required');
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('Messages array is required and must not be empty');
    if (!this.baseUrl) throw new Error('Custom API base URL is not configured. Please add it in Settings.');
    if (!this._parsedBase) throw new Error('Custom API base URL is invalid. Please check it in Settings.');

    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    let fullResponse = '';
    const startTime = Date.now();
    let firstTokenTime = null;
    let tokenCount = 0;
    const onProgress = opts.onProgress || (() => {});

    const requestBody = {
      model,
      messages,
      stream: true,
      temperature: opts.temperature !== undefined ? opts.temperature : 0.7,
    };
    if (Array.isArray(opts.tools) && opts.tools.length > 0) {
      requestBody.tools = opts.tools;
    }

    // Same incremental-fragment accumulation as OpenAIClient/DeepSeekClient — most
    // OpenAI-compatible providers stream tool_calls the same piecemeal way.
    const toolCallAccumulator = {};

    // Reasoning models stream their chain of thought before any answer text; these
    // track it so the UI can show the turn is alive (see the delta handler below).
    let reasoningChars = 0;
    let lastReasoningReport = 0;

    // Stall timeout: aborts if the model goes silent for this long — whether that's
    // before the first token, or in the middle of an otherwise-active stream (a
    // one-shot "first token" timeout that gets permanently disarmed after the first
    // chunk arrives leaves everything after that point completely unbounded). Re-armed
    // on every chunk received below.
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

    // armStallTimeout() above is re-armed by EVERY chunk, including keep-alive frames
    // and reasoning deltas — traffic that carries no answer. That makes it impossible
    // for it to fire against a model that "thinks" indefinitely, so this one-shot
    // deadline (never re-armed) bounds how long a request may run without producing a
    // single usable token or tool call.
    const outputDeadline = armFirstOutputDeadline(
      () => firstTokenTime !== null,
      () => {
        if (this._abortController) {
          console.warn(`[CustomClient] No output after ${MAX_TIME_TO_FIRST_OUTPUT / 1000}s (reasoning/keep-alive only) — aborting.`);
          this._abortReason = 'stall';
          this._abortController.abort();
        }
      },
    );

    try {
      await this._streamRequestWithRetry('POST', '/chat/completions', requestBody, (chunk) => {
        armStallTimeout();
        if (!chunk.choices || chunk.choices.length === 0) return;
        const delta = chunk.choices[0].delta || {};

        // Reasoning models (the gpt-5 family via OpenRouter, R1-style models, ...) send
        // their thinking as `reasoning`/`reasoning_content` deltas, often for minutes
        // before the first answer token. These used to be dropped entirely: nothing
        // reached the UI, the token counter never moved, and the turn looked frozen.
        // Report them as progress only — thinking is not part of the model's answer, so
        // it must not land in fullResponse, and it deliberately does NOT set
        // firstTokenTime (the first-output deadline above still has to apply).
        const reasoningPiece = typeof delta.reasoning === 'string'
          ? delta.reasoning
          : (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '');
        if (reasoningPiece) {
          reasoningChars += reasoningPiece.length;
          const now = Date.now();
          if (now - lastReasoningReport >= REASONING_REPORT_INTERVAL) {
            lastReasoningReport = now;
            onProgress({
              event: 'reasoning',
              tokens: Math.ceil(reasoningChars / CHARS_PER_TOKEN),
              elapsed: now - startTime,
            });
          }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAccumulator[idx]) {
              toolCallAccumulator[idx] = { id: tc.id || '', function: { name: '', arguments: '' } };
            }
            if (tc.id) toolCallAccumulator[idx].id = tc.id;
            if (tc.function?.name) toolCallAccumulator[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCallAccumulator[idx].function.arguments += tc.function.arguments;
          }
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
            clearTimeout(firstTokenTimeout);
          }
        }

        if (delta.content) {
          const token = delta.content;
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
        }

        if (chunk.choices[0].finish_reason) {
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

    const toolCalls = Object.values(toolCallAccumulator).map((tc) => ({ function: { name: tc.function.name, arguments: tc.function.arguments } }));
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

module.exports = CustomClient;
