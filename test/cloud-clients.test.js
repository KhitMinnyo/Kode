'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const OpenAIClient = require('../src/openai/client');
const AnthropicClient = require('../src/anthropic/client');
const DeepSeekClient = require('../src/deepseek/client');

/**
 * All three clients take `_streamRequest(method, path, body, onData, opts)` as their
 * only network boundary inside chat(). Mocking it lets us replay a canned sequence of
 * real streaming payloads and exercise the actual accumulation/parsing logic inside
 * chat() end-to-end, without touching the network — this is what would have caught
 * bugs in the incremental tool_calls/input_json_delta accumulation before shipping.
 */
function mockStream(client, chunks) {
  client._streamRequest = async (method, path, body, onData) => {
    for (const chunk of chunks) onData(chunk);
  };
}

// ───────────────────────── OpenAI ─────────────────────────

test('OpenAIClient.chat accumulates streamed text content', async () => {
  const client = new OpenAIClient('fake-key');
  mockStream(client, [
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [{ delta: { content: ', world' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);

  const result = await client.chat('gpt-4o', [{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, 'Hello, world');
  assert.deepEqual(result.toolCalls, []);
});

test('OpenAIClient.chat reassembles tool_calls streamed as fragmented deltas across many chunks', async () => {
  const client = new OpenAIClient('fake-key');
  mockStream(client, [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '_file', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.py"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);

  const result = await client.chat('gpt-4o', [{ role: 'user', content: 'hi' }]);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { path: 'a.py' });
});

test('OpenAIClient.chat handles multiple parallel tool calls by index', async () => {
  const client = new OpenAIClient('fake-key');
  mockStream(client, [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'read_file', arguments: '{"path":"a"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'read_file', arguments: '{"path":"b"}' } }] } }] },
  ]);

  const result = await client.chat('gpt-4o', [{ role: 'user', content: 'hi' }]);
  assert.equal(result.toolCalls.length, 2);
  assert.deepEqual(result.toolCalls.map(tc => JSON.parse(tc.function.arguments).path), ['a', 'b']);
});

test('OpenAIClient._streamRequestWithRetry retries once on 429 then succeeds', async () => {
  const client = new OpenAIClient('fake-key');
  let calls = 0;
  client._streamRequest = async () => {
    calls++;
    if (calls === 1) {
      const err = new Error('rate limited');
      err.statusCode = 429;
      err.retryAfter = '0';
      throw err;
    }
  };

  await client._streamRequestWithRetry('POST', '/v1/chat/completions', {}, () => {}, {});
  assert.equal(calls, 2);
});

test('OpenAIClient._streamRequestWithRetry does not retry non-429 errors', async () => {
  const client = new OpenAIClient('fake-key');
  let calls = 0;
  client._streamRequest = async () => {
    calls++;
    const err = new Error('server error');
    err.statusCode = 500;
    throw err;
  };

  await assert.rejects(
    client._streamRequestWithRetry('POST', '/v1/chat/completions', {}, () => {}, {}),
    /server error/,
  );
  assert.equal(calls, 1, 'a non-429 error should not be retried');
});

// ───────────────────────── Anthropic ─────────────────────────

test('AnthropicClient.chat accumulates text_delta events', async () => {
  const client = new AnthropicClient('fake-key');
  mockStream(client, [
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } },
    { type: 'message_stop' },
  ]);

  const result = await client.chat('claude-sonnet-5', [{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, 'Hi there');
  assert.deepEqual(result.toolCalls, []);
});

test('AnthropicClient.chat reassembles a tool_use block from input_json_delta fragments', async () => {
  const client = new AnthropicClient('fake-key');
  mockStream(client, [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a.py"}' } },
    { type: 'message_stop' },
  ]);

  const result = await client.chat('claude-sonnet-5', [{ role: 'user', content: 'hi' }]);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { path: 'a.py' });
});

test('AnthropicClient._splitSystemAndConversation pulls all system-role messages out into one string', () => {
  const client = new AnthropicClient('fake-key');
  const { system, conversation } = client._splitSystemAndConversation([
    { role: 'system', content: 'base prompt' },
    { role: 'system', content: 'context note' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);
  assert.equal(system, 'base prompt\n\ncontext note');
  assert.deepEqual(conversation, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]);
});

test('AnthropicClient._convertTools maps shared tool schemas to Anthropic\'s input_schema shape', () => {
  const client = new AnthropicClient('fake-key');
  const converted = client._convertTools([
    { type: 'function', function: { name: 'read_file', description: 'reads a file', parameters: { type: 'object', properties: {} } } },
  ]);
  assert.deepEqual(converted, [{ name: 'read_file', description: 'reads a file', input_schema: { type: 'object', properties: {} } }]);
});

// ───────────────────────── DeepSeek ─────────────────────────

test('DeepSeekClient.chat accumulates streamed text content (OpenAI-compatible format)', async () => {
  const client = new DeepSeekClient('fake-key');
  mockStream(client, [
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [{ delta: { content: ' DeepSeek' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);

  const result = await client.chat('deepseek-chat', [{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, 'Hello DeepSeek');
  assert.deepEqual(result.toolCalls, []);
});

test('DeepSeekClient.chat reassembles fragmented tool_calls the same way as OpenAIClient', async () => {
  const client = new DeepSeekClient('fake-key');
  mockStream(client, [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run_', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'command', arguments: '{"command":"ls"}' } }] } }] },
  ]);

  const result = await client.chat('deepseek-chat', [{ role: 'user', content: 'hi' }]);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'run_command');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { command: 'ls' });
});
