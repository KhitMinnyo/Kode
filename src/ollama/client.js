'use strict';

const http = require('http');

const OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT = 30000;

class OllamaClient {
  constructor(baseUrl = OLLAMA_BASE_URL) {
    const parsed = new URL(baseUrl);
    this.host = parsed.hostname;
    this.port = parseInt(parsed.port, 10) || 11434;
    this.protocol = parsed.protocol;
    this._abortController = null;
  }

  /**
   * Internal helper to make HTTP requests using the native http module.
   * Returns a Promise that resolves with { statusCode, headers, body }.
   */
  _request(method, path, body = null, { timeout = DEFAULT_TIMEOUT, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        timeout,
      };

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf-8');
          resolve({ statusCode: res.statusCode, headers: res.headers, body: rawBody });
        });
        res.on('error', (err) => reject(err));
      });

      req.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          reject(new Error('Ollama is not running. Please start Ollama and try again.'));
        } else {
          reject(err);
        }
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request to ${path} timed out after ${timeout}ms`));
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
   * Internal helper for streaming HTTP requests.
   * Reads NDJSON line-by-line and calls onLine(parsedObject) for each.
   */
  _streamRequest(method, path, body, onLine, { timeout = 0, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      // No timeout for streaming — generation can take a long time
      if (timeout > 0) {
        options.timeout = timeout;
      }

      const req = http.request(options, (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const errorBody = Buffer.concat(chunks).toString('utf-8');
            let errorMsg;
            try {
              const parsed = JSON.parse(errorBody);
              errorMsg = parsed.error || errorBody;
            } catch {
              errorMsg = errorBody;
            }
            reject(new Error(`Ollama API error (${res.statusCode}): ${errorMsg}`));
          });
          return;
        }

        let buffer = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');

          // Process complete lines (NDJSON)
          const lines = buffer.split('\n');
          // Keep the last partial line in the buffer
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            try {
              const parsed = JSON.parse(trimmed);
              onLine(parsed);
            } catch (err) {
              // Skip malformed lines
              console.warn('[OllamaClient] Failed to parse NDJSON line:', trimmed);
            }
          }
        });

        res.on('end', () => {
          // Process any remaining data in buffer
          if (buffer.trim().length > 0) {
            try {
              const parsed = JSON.parse(buffer.trim());
              onLine(parsed);
            } catch {
              // Ignore trailing partial data
            }
          }
          resolve();
        });

        res.on('error', (err) => reject(err));
      });

      req.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          reject(new Error('Ollama is not running. Please start Ollama and try again.'));
        } else if (err.message === 'Request aborted' || err.code === 'ECONNRESET') {
          // Gracefully handle abort
          resolve();
        } else {
          reject(err);
        }
      });

      if (timeout > 0) {
        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`Streaming request to ${path} timed out`));
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

  /**
   * Check if Ollama is running and reachable.
   * @returns {Promise<{connected: boolean, error?: string}>}
   */
  async checkConnection() {
    try {
      const res = await this._request('GET', '/api/tags', null, { timeout: 5000 });
      if (res.statusCode === 200) {
        return { connected: true };
      }
      return { connected: false, error: `Unexpected status code: ${res.statusCode}` };
    } catch (err) {
      return { connected: false, error: err.message };
    }
  }

  /**
   * List all locally available models.
   * @returns {Promise<Array<{name: string, size: number, modified_at: string, details: object}>>}
   */
  async listModels() {
    const res = await this._request('GET', '/api/tags', null, { timeout: 10000 });

    if (res.statusCode !== 200) {
      throw new Error(`Failed to list models: HTTP ${res.statusCode}`);
    }

    const data = JSON.parse(res.body);
    if (!data.models || !Array.isArray(data.models)) {
      return [];
    }

    return data.models.map((model) => ({
      name: model.name,
      size: model.size,
      modified_at: model.modified_at,
      details: model.details || {},
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

    const res = await this._request('POST', '/api/show', { name: model }, { timeout: 10000 });

    if (res.statusCode !== 200) {
      throw new Error(`Failed to get model info for "${model}": HTTP ${res.statusCode}`);
    }

    return JSON.parse(res.body);
  }

  /**
   * Get the context window size (num_ctx) for a model.
   * @param {string} model - The model name
   * @returns {Promise<number>} - Context size in tokens (default 4096 if unknown)
   */
  async getContextSize(model) {
    try {
      const info = await this.getModelInfo(model);
      // Check modelfile parameters for num_ctx
      if (info.parameters) {
        const match = info.parameters.match(/num_ctx\s+(\d+)/);
        if (match) return parseInt(match[1], 10);
      }
      // Check model_info object
      if (info.model_info) {
        const ctxKey = Object.keys(info.model_info).find(k => k.includes('context_length'));
        if (ctxKey) return info.model_info[ctxKey];
      }
      return 4096; // safe default
    } catch {
      return 4096;
    }
  }

  /**
   * Send a chat request with streaming support.
   * @param {string} model - The model name to use
   * @param {Array<{role: string, content: string}>} messages - Conversation messages
   * @param {function(string): void} onChunk - Callback invoked with each text token
   * @param {object} [opts] - Options
   * @param {number} [opts.contextSize] - Override num_ctx for this request
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

    // Create a new AbortController for this request
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    let fullResponse = '';
    const startTime = Date.now();
    let firstTokenTime = null;
    let tokenCount = 0;
    const onProgress = opts.onProgress || (() => {});

    const numCtx = opts.contextSize || 4096;

    const requestBody = {
      model,
      messages,
      stream: true,
      options: {
        num_ctx: numCtx,
        temperature: 0.7,
        num_predict: Math.min(2048, Math.floor(numCtx * 0.4)),
      },
    };

    // First-token timeout: reasoning models (deepseek-r1) can take minutes to think
    const FIRST_TOKEN_TIMEOUT = 300000; // 5 minutes
    const firstTokenTimeout = setTimeout(() => {
      if (!firstTokenTime && this._abortController) {
        console.warn('[OllamaClient] First-token timeout (5min) — aborting.');
        this._abortController.abort();
      }
    }, FIRST_TOKEN_TIMEOUT);

    try {
      let chunkCount = 0;
      await this._streamRequest('POST', '/api/chat', requestBody, (chunk) => {
        chunkCount++;
        // Debug: log first chunk structure
        if (chunkCount === 1) {
          console.log('[OllamaClient] First chunk keys:', Object.keys(chunk), 'message keys:', chunk.message ? Object.keys(chunk.message) : 'none');
        }

        if (chunk.message && chunk.message.content !== undefined) {
          const token = chunk.message.content;
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
            console.log(`[OllamaClient] First token in ${latency}ms`);
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

        if (chunk.done === true) {
          clearTimeout(firstTokenTimeout);
          const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
          const tps = firstTokenTime ? (tokenCount / ((Date.now() - firstTokenTime) / 1000)).toFixed(1) : 0;
          console.log(`[OllamaClient] Done: ${tokenCount} tokens in ${totalTime}s (${tps} tok/s)`);
          onProgress({ event: 'done', tokens: tokenCount, totalTime: parseFloat(totalTime), tokensPerSec: parseFloat(tps) });
        }
      }, { signal });
    } catch (err) {
      clearTimeout(firstTokenTimeout);
      if (err.message === 'Request aborted') {
        if (!firstTokenTime) {
          return '⏱️ Model took too long to respond. Try a smaller/faster model or simplify your request.';
        }
        return fullResponse;
      }
      throw err;
    } finally {
      clearTimeout(firstTokenTimeout);
      this._abortController = null;
    }

    return fullResponse;
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

  /**
   * Update the base URL for the Ollama server.
   * @param {string} newBaseUrl - The new base URL (e.g., 'http://192.168.1.100:11434')
   */
  updateBaseUrl(newBaseUrl) {
    const parsed = new URL(newBaseUrl);
    this.host = parsed.hostname;
    this.port = parseInt(parsed.port, 10) || 11434;
    this.protocol = parsed.protocol;
  }
}

module.exports = OllamaClient;
