'use strict';

const https = require('https');

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT = 30000;

// Hardcoded model catalog — DeepSeek has a fixed set of models.
//
// The old names (`deepseek-chat`, `deepseek-coder`, `deepseek-reasoner`) were
// discontinued by DeepSeek on 2026-07-24 — per their changelog, they spent their
// last few months as aliases pointing at deepseek-v4-flash's non-thinking/thinking
// modes before being retired outright. `deepseek-coder` was already folded into
// `deepseek-chat` back in 2024. Current lineup: deepseek-v4-flash (fast, general
// purpose) and deepseek-v4-pro (harder reasoning), both with a ~1M-token context
// window; deepseek-v4-flash-vision-exp is the same Flash model with image input.
const DEEPSEEK_MODELS = [
  { name: 'deepseek-v4-flash', description: 'Fast, general-purpose model', context_length: 1000000 },
  { name: 'deepseek-v4-pro', description: 'Harder reasoning tasks', context_length: 1000000 },
  { name: 'deepseek-v4-flash-vision-exp', description: 'Flash model with image input (experimental)', context_length: 1000000 },
];

const CONTEXT_SIZES = {
  'deepseek-v4-flash': 1000000,
  'deepseek-v4-pro': 1000000,
  'deepseek-v4-flash-vision-exp': 1000000,
};

class DeepSeekClient {
  constructor(apiKey = '') {
    this.apiKey = apiKey;
    this._abortController = null;
  }

  /**
   * Update the API key used for authentication.
   * @param {string} newKey - The new DeepSeek API key
   */
  updateApiKey(newKey) {
    this.apiKey = newKey || '';
  }

  /**
   * Internal helper to make HTTPS requests using the native https module.
   * Returns a Promise that resolves with { statusCode, headers, body }.
   */
  _request(method, urlPath, body = null, { timeout = DEFAULT_TIMEOUT, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.deepseek.com',
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
          const rawBody = Buffer.concat(chunks).toString('utf-8');
          resolve({ statusCode: res.statusCode, headers: res.headers, body: rawBody });
        });
        res.on('error', (err) => reject(err));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request to ${urlPath} timed out after ${timeout}ms`));
      });

      // Wire up abort signal
      if (signal) {
        if (signal.aborted) {
          req.destroy();
          reject(new Error('Request aborted'));
          return;
        }
        signal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('Request aborted'));
        }, { once: true });
      }

      if (body !== null) {
        const payload = JSON.stringify(body);
        req.setHeader('Content-Length', Buffer.byteLength(payload));
        req.write(payload);
      }

      req.end();
    });
  }

  /**
   * Internal helper for streaming HTTPS requests (SSE format).
   * Reads SSE lines (data: {...}) and calls onData(parsedObject) for each.
   */
  _streamRequest(method, urlPath, body, onData, { timeout = 0, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.deepseek.com',
        port: 443,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'text/event-stream',
        },
      };

      // No timeout for streaming — generation can take a long time
      if (timeout > 0) {
        options.timeout = timeout;
      }

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
            const err = new Error(`DeepSeek API error (${res.statusCode}): ${errorMsg}`);
            err.statusCode = res.statusCode;
            err.retryAfter = res.headers['retry-after'];
            reject(err);
          });
          return;
        }

        let buffer = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');

          // Process complete SSE lines
          const lines = buffer.split('\n');
          // Keep the last partial line in the buffer
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;

            // SSE format: lines starting with "data: "
            if (trimmed.startsWith('data: ')) {
              const dataStr = trimmed.slice(6);
              // Stream termination signal
              if (dataStr === '[DONE]') {
                continue;
              }
              try {
                const parsed = JSON.parse(dataStr);
                onData(parsed);
              } catch (err) {
                // Skip malformed SSE lines
                console.warn('[DeepSeekClient] Failed to parse SSE data:', dataStr);
              }
            }
          }
        });

        res.on('end', () => {
          // Process any remaining data in buffer
          if (buffer.trim().length > 0) {
            const trimmed = buffer.trim();
            if (trimmed.startsWith('data: ')) {
              const dataStr = trimmed.slice(6);
              if (dataStr !== '[DONE]') {
                try {
                  const parsed = JSON.parse(dataStr);
                  onData(parsed);
                } catch {
                  // Ignore trailing partial data
                }
              }
            }
          }
          resolve();
        });

        res.on('error', (err) => reject(err));
      });

      req.on('error', (err) => {
        if (err.message === 'Request aborted' || err.code === 'ECONNRESET') {
          // Gracefully handle abort
          resolve();
        } else {
          reject(err);
        }
      });

      if (timeout > 0) {
        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`Streaming request to ${urlPath} timed out`));
        });
      }

      // Wire up abort signal
      if (signal) {
        if (signal.aborted) {
          req.destroy();
          resolve();
          return;
        }
        signal.addEventListener('abort', () => {
          req.destroy();
        }, { once: true });
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
          console.warn(`[DeepSeekClient] Rate limited (429) — retrying in ${waitMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Check if the DeepSeek API is reachable and the API key is valid.
   * @returns {Promise<{connected: boolean, error?: string}>}
   */
  async checkConnection() {
    if (!this.apiKey) {
      return { connected: false, error: 'No API key configured' };
    }
    try {
      const res = await this._request('GET', '/v1/models', null, { timeout: 10000 });
      if (res.statusCode === 200) {
        return { connected: true };
      }
      if (res.statusCode === 401) {
        return { connected: false, error: 'Invalid API key' };
      }
      return { connected: false, error: `Unexpected status code: ${res.statusCode}` };
    } catch (err) {
      return { connected: false, error: err.message };
    }
  }

  /**
   * List available DeepSeek models.
   * Returns a hardcoded list since DeepSeek has a fixed model catalog.
   * @returns {Promise<Array<{name: string, size: number, modified_at: string, details: object}>>}
   */
  async listModels() {
    return DEEPSEEK_MODELS.map((model) => ({
      name: model.name,
      size: 0,
      modified_at: '',
      details: {
        description: model.description,
        context_length: model.context_length,
      },
    }));
  }

  /**
   * Get detailed information about a specific model.
   * @param {string} model - The model name
   * @returns {Promise<object>}
   */
  async getModelInfo(model) {
    if (!model || typeof model !== 'string') {
      throw new Error('Model name is required');
    }

    const info = DEEPSEEK_MODELS.find((m) => m.name === model);
    if (!info) {
      return {
        name: model,
        details: { context_length: 1000000 },
      };
    }

    return {
      name: info.name,
      details: {
        description: info.description,
        context_length: info.context_length,
      },
    };
  }

  /**
   * Get the context window size for a model.
   * @param {string} model - The model name
   * @returns {Promise<number>} - Context size in tokens
   */
  async getContextSize(model) {
    return CONTEXT_SIZES[model] || 1000000;
  }

  /**
   * Send a chat request with streaming support.
   * @param {string} model - The model name to use
   * @param {Array<{role: string, content: string}>} messages - Conversation messages
   * @param {function(string): void} onChunk - Callback invoked with each text token
   * @param {object} [opts] - Options
   * @param {number} [opts.contextSize] - Context size (informational, handled by DeepSeek)
   * @param {function(object): void} [opts.onProgress] - Progress callback: { event, elapsed, tokens, tokensPerSec }
   * @returns {Promise<string>} - The full response text
   */
  async chat(model, messages, onChunk = () => {}, opts = {}) {
    if (!model || typeof model !== 'string') {
      throw new Error('Model name is required');
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('Messages array is required and must not be empty');
    }
    if (!this.apiKey) {
      throw new Error('DeepSeek API key is not configured. Please add your API key in Settings.');
    }

    // Create a new AbortController for this request
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
      // DeepSeek's docs don't publish a numeric default, and v4 models support up to
      // ~384K output tokens — the old hardcoded 2048 here was far too small for an
      // agent turn that writes a real file (create_file/edit_file/apply_patch put the
      // whole file's content inside the tool call's arguments, which count against
      // this same budget). Hitting that ceiling silently truncated the response
      // mid-tool-call, which looked exactly like "the agent did a little and stopped."
      // 32768 gives generous headroom (well clear of the real ~384K ceiling) while
      // staying configurable via opts.maxTokens. This is a cap, not a target — the
      // model still stops on its own once it's actually done, so there's no cost to
      // setting it generously high.
      max_tokens: opts.maxTokens || 32768,
    };
    if (Array.isArray(opts.tools) && opts.tools.length > 0) {
      requestBody.tools = opts.tools;
    }

    // Same incremental-fragment accumulation as OpenAIClient — DeepSeek's API is
    // OpenAI-compatible, including how streamed tool_calls arrive in pieces.
    const toolCallAccumulator = {};

    // First-token timeout: reasoning models can take minutes to think
    const FIRST_TOKEN_TIMEOUT = 300000; // 5 minutes
    const firstTokenTimeout = setTimeout(() => {
      if (!firstTokenTime && this._abortController) {
        console.warn('[DeepSeekClient] First-token timeout (5min) — aborting.');
        this._abortController.abort();
      }
    }, FIRST_TOKEN_TIMEOUT);

    try {
      let chunkCount = 0;
      await this._streamRequestWithRetry('POST', '/v1/chat/completions', requestBody, (chunk) => {
        chunkCount++;
        // Debug: log first chunk structure
        if (chunkCount === 1) {
          console.log('[DeepSeekClient] First chunk keys:', Object.keys(chunk));
        }

        // OpenAI-compatible SSE: chunk.choices[0].delta.content
        if (chunk.choices && chunk.choices.length > 0) {
          const delta = chunk.choices[0].delta;

          if (delta && Array.isArray(delta.tool_calls)) {
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

          if (delta && delta.content !== undefined && delta.content !== null) {
            const token = delta.content;
            // Skip truly empty tokens but count them for timeout purposes
            if (token === '') {
              if (!firstTokenTime) {
                firstTokenTime = Date.now();
                clearTimeout(firstTokenTimeout);
              }
              return;
            }

            fullResponse += token;
            tokenCount++;

            if (!firstTokenTime) {
              firstTokenTime = Date.now();
              clearTimeout(firstTokenTimeout);
              const latency = firstTokenTime - startTime;
              console.log(`[DeepSeekClient] First token in ${latency}ms`);
              onProgress({ event: 'first-token', elapsed: latency });
            }

            onChunk(token);

            // Report progress every 20 tokens
            if (tokenCount % 20 === 0) {
              const elapsed = (Date.now() - firstTokenTime) / 1000;
              const tps = elapsed > 0 ? (tokenCount / elapsed).toFixed(1) : 0;
              onProgress({ event: 'progress', tokens: tokenCount, tokensPerSec: parseFloat(tps) });
            }
          }

          // Check for finish reason
          const finishReason = chunk.choices[0].finish_reason;
          if (finishReason) {
            clearTimeout(firstTokenTimeout);
            const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
            const tps = firstTokenTime ? (tokenCount / ((Date.now() - firstTokenTime) / 1000)).toFixed(1) : 0;
            console.log(`[DeepSeekClient] Done (${finishReason}): ${tokenCount} tokens in ${totalTime}s (${tps} tok/s)`);
            onProgress({ event: 'done', tokens: tokenCount, totalTime: parseFloat(totalTime), tokensPerSec: parseFloat(tps) });
          }
        }
      }, { signal });
    } catch (err) {
      clearTimeout(firstTokenTimeout);
      if (err.message === 'Request aborted') {
        if (!firstTokenTime) {
          return { text: '⏱️ Model took too long to respond. Try a different model or simplify your request.', toolCalls: [] };
        }
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

  /**
   * Abort the current in-flight chat request.
   */
  abort() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }
}

module.exports = DeepSeekClient;
