'use strict';

const https = require('https');

const {
  MAX_TIME_TO_FIRST_OUTPUT,
  REASONING_REPORT_INTERVAL,
  CHARS_PER_TOKEN,
  guardStreamingRequest,
  armFirstOutputDeadline,
} = require('../shared/streamGuards');

const DEFAULT_TIMEOUT = 30000;

// Model names OpenAI's /v1/models endpoint returns that aren't chat models at all
// (embeddings, audio, image, moderation, etc.) — filtered out of listModels() since
// Kode's UI only wants to offer models that can actually hold a conversation.
const NON_CHAT_PATTERNS = [
  /embedding/i, /whisper/i, /tts/i, /^dall-e/i, /moderation/i,
  /davinci|babbage|curie|ada-/i, /^text-/i, /^omni-moderation/i,
];

class OpenAIClient {
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

  _request(method, urlPath, body = null, { timeout = DEFAULT_TIMEOUT, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.openai.com',
        port: 443,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        timeout,
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') });
        });
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
      const options = {
        hostname: 'api.openai.com',
        port: 443,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'text/event-stream',
        },
      };

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
            const err = new Error(`OpenAI API error (${res.statusCode}): ${errorMsg}`);
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
              console.warn('[OpenAIClient] Failed to parse SSE data:', dataStr);
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

  /**
   * Runs _streamRequest with one automatic retry on HTTP 429 (rate limit), honoring
   * the Retry-After header when the API sends one. A 429 always arrives as the
   * initial response status before any streaming data, so it's always safe to retry
   * the whole request from scratch — no partial output has been emitted yet.
   */
  async _streamRequestWithRetry(method, urlPath, body, onData, opts) {
    const MAX_RETRIES = 1;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._streamRequest(method, urlPath, body, onData, opts);
      } catch (err) {
        if (err.statusCode === 429 && attempt < MAX_RETRIES) {
          const waitMs = err.retryAfter ? parseInt(err.retryAfter, 10) * 1000 : 2000;
          console.warn(`[OpenAIClient] Rate limited (429) — retrying in ${waitMs}ms`);
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
      const res = await this._request('GET', '/v1/models', null, { timeout: 10000 });
      if (res.statusCode === 200) return { connected: true };
      if (res.statusCode === 401) return { connected: false, error: 'Invalid API key' };
      return { connected: false, error: `Unexpected status code: ${res.statusCode}` };
    } catch (err) {
      return { connected: false, error: err.message };
    }
  }

  /**
   * List chat-capable models. OpenAI's /v1/models returns everything (embeddings,
   * TTS, image models, etc.) with no "is this a chat model" flag, so we filter out
   * known non-chat name patterns rather than hardcoding a model list that goes stale.
   */
  async listModels() {
    const res = await this._request('GET', '/v1/models', null, { timeout: 10000 });
    if (res.statusCode !== 200) {
      throw new Error(`Failed to list models: HTTP ${res.statusCode}`);
    }
    const data = JSON.parse(res.body);
    const all = Array.isArray(data.data) ? data.data : [];
    return all
      .filter((m) => !NON_CHAT_PATTERNS.some((p) => p.test(m.id)))
      .map((m) => ({ name: m.id, size: 0, modified_at: m.created ? new Date(m.created * 1000).toISOString() : '', details: {} }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getModelInfo(model) {
    return { name: model, details: { context_length: 1050000 } };
  }

  /**
   * OpenAI doesn't expose per-model context length via API. Current flagship models
   * (GPT-6 Astra, GPT-5.6 Sol/Terra/Luna) all share a ~1.05M-token context window
   * with 128K max output — the previous flat 128000 here undersold the real context
   * by ~8x, needlessly throttling _buildContextMessages's history budget (agent/core.js).
   */
  async getContextSize() {
    return 1050000;
  }

  /**
   * @returns {Promise<{text: string, toolCalls: Array<object>}>}
   */
  async chat(model, messages, onChunk = () => {}, opts = {}) {
    if (!model || typeof model !== 'string') throw new Error('Model name is required');
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('Messages array is required and must not be empty');
    if (!this.apiKey) throw new Error('OpenAI API key is not configured. Please add your API key in Settings.');

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

    // Accumulate streamed tool_calls by index — OpenAI sends each tool call's
    // `arguments` as incremental string fragments across many chunks, unlike Ollama
    // which sends the whole thing in one shot.
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
    // and reasoning deltas — traffic that carries no answer. This one-shot deadline is
    // never re-armed, so it bounds how long a request may run without producing a
    // single usable token or tool call.
    const outputDeadline = armFirstOutputDeadline(
      () => firstTokenTime !== null,
      () => {
        if (this._abortController) {
          console.warn(`[OpenAIClient] No output after ${MAX_TIME_TO_FIRST_OUTPUT / 1000}s (reasoning/keep-alive only) — aborting.`);
          this._abortReason = 'stall';
          this._abortController.abort();
        }
      },
    );

    try {
      await this._streamRequestWithRetry('POST', '/v1/chat/completions', requestBody, (chunk) => {
        armStallTimeout();
        if (!chunk.choices || chunk.choices.length === 0) return;
        const delta = chunk.choices[0].delta || {};

        // Reasoning models (o-series, gpt-5 family) stream their thinking as
        // `reasoning`/`reasoning_content` deltas, often for minutes before the first
        // answer token. Report them as progress only — thinking is not part of the
        // model's answer, so it must not land in fullResponse, and it deliberately does
        // NOT set firstTokenTime (the first-output deadline still has to apply).
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

module.exports = OpenAIClient;
