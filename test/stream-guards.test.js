'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  guardStreamingRequest,
  armFirstOutputDeadline,
} = require('../src/shared/streamGuards');

const CustomClient = require('../src/custom/client');
const OpenAIClient = require('../src/openai/client');
const DeepSeekClient = require('../src/deepseek/client');
const AnthropicClient = require('../src/anthropic/client');
const OllamaClient = require('../src/ollama/client');

/**
 * Regression tests for the "Planning and analyzing... forever" hang.
 *
 * The failure it covers had four parts, each represented below:
 *   1. an aborted stream resolved as if it had ended cleanly, so the `stalled` flag
 *      never reached AgentCore;
 *   2. AgentCore therefore treated a 5-minute stall as an ordinary empty response and
 *      retried it on a path with no budget, re-sending the whole conversation each time;
 *   3. reasoning deltas were dropped on the floor, so a thinking model produced no UI
 *      signal at all while it kept the stall timeout re-armed indefinitely;
 *   4. nothing bounded a connection that simply stopped delivering data, so the
 *      request promise — and the send-message IPC call waiting on it — never settled.
 */

/** Same mock boundary the other client tests use: replay canned chunks through chat(). */
function mockStream(client, chunks) {
  client._streamRequest = async (method, path, body, onData) => {
    for (const chunk of chunks) onData(chunk);
  };
}

/** Starts a server that accepts the request and then behaves as `behavior` says. */
function startServer(behavior) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      behavior(req, res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ───────────────── guardStreamingRequest: the socket-level backstop ─────────────────

test('guardStreamingRequest kills a connection that stops delivering data and tags it timedOut', async () => {
  // A peer that accepts the connection and then goes silent forever — laptop asleep,
  // network changed, proxy dropped the tunnel. Nothing in the old code could see this:
  // no bytes means nothing re-arms the stall timeout and nothing settles the promise.
  const { server, port } = await startServer(() => { /* never responds */ });

  const err = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST' }, (res) => {
      res.on('data', () => {});
      res.on('end', () => reject(new Error('stream ended normally — expected a timeout')));
      res.on('error', (e) => resolve(guard.mapError(e)));
    });
    req.on('error', (e) => resolve(guard.mapError(e)));
    const guard = guardStreamingRequest(req, { urlPath: '/v1/chat/completions', idleTimeout: 300 });
    req.end('{}');
  });

  assert.equal(err.timedOut, true, 'a dead connection must surface as a timedOut error, not hang');
  assert.match(err.message, /no data for 0s|no data for \d+s/);
  server.close();
});

test('guardStreamingRequest maps an abort to a tagged "Request aborted" error rather than a silent success', async () => {
  // The exact shape of the original bug: req.destroy() emits ECONNRESET, which the old
  // code treated as a clean finish (resolve()), so the caller's catch — the only place
  // that sets `stalled` — never ran.
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{}}]}\n\n'); // then silence
  });
  const ac = new AbortController();

  const err = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST' }, (res) => {
      res.on('data', () => {});
      res.on('end', () => reject(new Error('stream ended normally — expected an abort')));
      res.on('error', (e) => resolve(guard.mapError(e)));
    });
    req.on('error', (e) => resolve(guard.mapError(e)));
    const guard = guardStreamingRequest(req, { urlPath: '/v1/chat/completions', signal: ac.signal });
    req.end('{}');
    setTimeout(() => ac.abort(), 50);
  });

  assert.equal(err.aborted, true);
  assert.equal(err.message, 'Request aborted');
  server.close();
});

test('armFirstOutputDeadline fires only when no output ever arrived', async () => {
  let firedWithoutOutput = false;
  armFirstOutputDeadline(() => false, () => { firedWithoutOutput = true; }, 30);

  let firedWithOutput = false;
  armFirstOutputDeadline(() => true, () => { firedWithOutput = true; }, 30);

  await new Promise((r) => setTimeout(r, 120));
  assert.equal(firedWithoutOutput, true, 'a request that produced nothing must be cut off');
  assert.equal(firedWithOutput, false, 'a request that produced output must be left alone');
});

// ───────────────── the stall flag actually reaches the caller ─────────────────

test('CustomClient.chat reports stalled:true when the stall timeout aborts a live but silent stream', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': keep-alive\n\n'); // provider is "processing" — then nothing
  });
  const client = new CustomClient('', `http://127.0.0.1:${port}/v1`);

  const chatPromise = client.chat('some-model', [{ role: 'user', content: 'hi' }]);
  // Fire exactly what the 5-minute stall timer inside chat() does, without the wait.
  setTimeout(() => {
    client._abortReason = 'stall';
    client._abortController.abort();
  }, 60);

  const result = await chatPromise;
  assert.equal(result.stalled, true, 'a stall must be reported as a stall, not as an empty response');
  assert.match(result.text, /took too long/i);
  server.close();
});

test('CustomClient.chat keeps a user-pressed Stop distinguishable from a stall', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  const client = new CustomClient('', `http://127.0.0.1:${port}/v1`);

  const chatPromise = client.chat('some-model', [{ role: 'user', content: 'hi' }]);
  setTimeout(() => client.abort(), 80);

  const result = await chatPromise;
  assert.equal(result.stalled, false, 'Stop is a deliberate user action, never a stall');
  assert.equal(result.text, 'partial', 'text streamed before Stop is kept');
  server.close();
});

test('CustomClient.chat treats a dead-connection timeout as a stall the agent loop can budget', async () => {
  const client = new CustomClient('', 'http://127.0.0.1:1/v1');
  client._streamRequest = async () => {
    throw Object.assign(new Error('Streaming request to /chat/completions received no data for 360s'), { timedOut: true });
  };

  const result = await client.chat('some-model', [{ role: 'user', content: 'hi' }]);
  assert.equal(result.stalled, true);
});

// ───────────────── reasoning deltas are surfaced, not dropped ─────────────────

test('CustomClient.chat reports reasoning deltas as progress without putting them in the answer', async () => {
  const client = new CustomClient('', 'http://127.0.0.1:1/v1');
  mockStream(client, [
    { choices: [{ delta: { reasoning: 'Let me look at the plan. ' } }] },
    { choices: [{ delta: { reasoning: 'The audit should come first. ' } }] },
    { choices: [{ delta: { content: 'Here is the answer.' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);

  const events = [];
  const result = await client.chat('gpt-5', [{ role: 'user', content: 'hi' }], () => {}, {
    onProgress: (p) => events.push(p),
  });

  const reasoningEvents = events.filter((e) => e.event === 'reasoning');
  assert.ok(reasoningEvents.length >= 1, 'reasoning must reach the UI as progress');
  assert.ok(reasoningEvents[0].tokens > 0);
  assert.equal(result.text, 'Here is the answer.', 'thinking must never leak into the answer text');
});

test('OpenAIClient.chat surfaces reasoning_content deltas the same way', async () => {
  const client = new OpenAIClient('fake-key');
  mockStream(client, [
    { choices: [{ delta: { reasoning_content: 'thinking hard...' } }] },
    { choices: [{ delta: { content: 'done' } }] },
  ]);

  const events = [];
  const result = await client.chat('gpt-5', [{ role: 'user', content: 'hi' }], () => {}, {
    onProgress: (p) => events.push(p),
  });

  assert.ok(events.some((e) => e.event === 'reasoning'));
  assert.equal(result.text, 'done');
});

test('DeepSeekClient.chat surfaces reasoning_content deltas', async () => {
  const client = new DeepSeekClient('fake-key');
  mockStream(client, [
    { choices: [{ delta: { reasoning_content: 'step 1 ... step 2 ...' } }] },
    { choices: [{ delta: { content: 'answer' } }] },
  ]);

  const events = [];
  const result = await client.chat('deepseek-v4-pro', [{ role: 'user', content: 'hi' }], () => {}, {
    onProgress: (p) => events.push(p),
  });

  assert.ok(events.some((e) => e.event === 'reasoning'));
  assert.equal(result.text, 'answer');
});

test('AnthropicClient.chat surfaces thinking_delta events without adding them to the answer', async () => {
  const client = new AnthropicClient('fake-key');
  mockStream(client, [
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'considering the options' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Final answer.' } },
    { type: 'message_stop' },
  ]);

  const events = [];
  const result = await client.chat('claude-test', [{ role: 'user', content: 'hi' }], () => {}, {
    onProgress: (p) => events.push(p),
  });

  assert.ok(events.some((e) => e.event === 'reasoning'));
  assert.equal(result.text, 'Final answer.');
});

test('OllamaClient.chat surfaces a thinking model\'s thinking field as progress', async () => {
  const client = new OllamaClient();
  mockStream(client, [
    { message: { thinking: 'hmm, the file is large' } },
    { message: { content: 'Here goes.' } },
    { done: true },
  ]);

  const events = [];
  const result = await client.chat('qwen3', [{ role: 'user', content: 'hi' }], () => {}, {
    contextSize: 4096,
    onProgress: (p) => events.push(p),
  });

  assert.ok(events.some((e) => e.event === 'reasoning'));
  assert.equal(result.text, 'Here goes.');
});

test('reasoning alone does not count as output, so a thinking-only stream is still treated as a stall', async () => {
  // The heart of the hang: reasoning traffic kept the stall timeout re-armed while
  // producing nothing. Reasoning must not set firstTokenTime, so an abort after a
  // reasoning-only stream still reports the "no output at all" result.
  const client = new CustomClient('', 'http://127.0.0.1:1/v1');
  client._streamRequest = async (method, path, body, onData) => {
    onData({ choices: [{ delta: { reasoning: 'thinking and thinking and thinking' } }] });
    const err = new Error('Request aborted');
    err.aborted = true;
    throw err;
  };
  client._abortController = new AbortController();
  client._abortReason = 'stall';

  const result = await client.chat('gpt-5', [{ role: 'user', content: 'hi' }]);
  assert.equal(result.stalled, true);
  assert.match(result.text, /took too long/i, 'a stream that only ever produced reasoning produced no answer');
});

// ───────────────── AgentCore: every retry path is budgeted ─────────────────

const AgentCore = require('../src/agent/core');

test('processMessage stops nudging an empty-responding model instead of looping to the iteration ceiling', async () => {
  // This is the token burn. Every retry re-sends the ENTIRE conversation, and the
  // plain-empty branch used to have no budget at all — so a model returning nothing
  // ran all 25 tool iterations, each one paying for a full context window, before
  // anything stopped it.
  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async () => {
      chatCallCount++;
      return { text: '', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama'); // default maxToolIterations = 25
  const result = await core.processMessage('audit this project', 'test-model', [], () => {}, () => {}, null, () => {});

  assert.equal(chatCallCount, 4, 'expected 3 nudges then a give-up, not 25 full-context retries');
  assert.match(result.response, /empty response/i);
});

test('processMessage still gives up cleanly after the stall budget is spent', async () => {
  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async () => {
      chatCallCount++;
      return { text: '', toolCalls: [], stalled: true };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  const result = await core.processMessage('audit this project', 'test-model', [], () => {}, () => {}, null, () => {});

  assert.equal(chatCallCount, 4, 'expected 3 stall nudges then a give-up');
  assert.match(result.response, /stalled repeatedly/i);
});

test('processMessage forwards reasoning progress to the status callback so a thinking turn looks alive', async () => {
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async (model, messages, onChunk, opts) => {
      opts.onProgress({ event: 'reasoning', tokens: 420, elapsed: 65000 });
      return { text: '✅ Done: nothing to change.', toolCalls: [] };
    },
  };

  const statuses = [];
  const core = new AgentCore(mockClient, 8192, 'ollama');
  await core.processMessage('audit this', 'test-model', [], () => {}, () => {}, null, (s) => statuses.push(s));

  const thinking = statuses.find((s) => /reasoning tokens/.test(s.message || ''));
  assert.ok(thinking, 'a reasoning model must produce a visible, updating status');
  assert.match(thinking.message, /Thinking\.\.\. \(~420 reasoning tokens, 65s\)/);
});
