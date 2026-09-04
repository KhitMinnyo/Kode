'use strict';

const https = require('https');
const http = require('http');

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
        res.on('error', (err) => reject(err));
      });

      req.on('error', (err) => {
        if (err.message === 'Request aborted' || err.code === 'ECONNRESET') resolve();
        else reject(err);
      });

      if (signal) {
        if (signal.aborted) { req.destroy(); resolve(); return; }
        signal.addEventListener('abort', () => { req.destroy(); }, { once: true });
      }

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

    const FIRST_TOKEN_TIMEOUT = 300000;
    const firstTokenTimeout = setTimeout(() => {
      if (!firstTokenTime && this._abortController) this._abortController.abort();
    }, FIRST_TOKEN_TIMEOUT);

    try {
      await this._streamRequestWithRetry('POST', '/chat/completions', requestBody, (chunk) => {
        if (!chunk.choices || chunk.choices.length === 0) return;
        const delta = chunk.choices[0].delta || {};

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
      if (err.message === 'Request aborted') {
        if (!firstTokenTime) return { text: '⏱️ Model took too long to respond. Try a different model or simplify your request.', toolCalls: [] };
        return { text: fullResponse, toolCalls: [] };
      }
      throw err;
    } finally {
      clearTimeout(firstTokenTimeout);
      this._abortController = null;
    }

    const toolCalls = Object.values(toolCallAccumulator).map((tc) => ({ function: { name: tc.function.name, arguments: tc.function.arguments } }));
    return { text: fullResponse, toolCalls };
  }

  abort() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }
}

module.exports = CustomClient;
