'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const AgentCore = require('../src/agent/core');
const { bucketNumCtx, estimateTokens, parseToolCalls, convertNativeToolCalls, stripToolBlocks } = AgentCore._testUtils;

test('bucketNumCtx picks the smallest bucket that fits', () => {
  assert.equal(bucketNumCtx(100, 16384), 2048);
  assert.equal(bucketNumCtx(2049, 16384), 4096);
  assert.equal(bucketNumCtx(16000, 16384), 16384);
});

test('bucketNumCtx never exceeds the model max, even if that max sits between buckets', () => {
  // 100 tokens comfortably fits the smallest bucket (2048) regardless of how high
  // maxContext is — bucketNumCtx always prefers the smallest bucket that fits.
  assert.equal(bucketNumCtx(100, 5000), 2048);
  // Once neededTokens exceeds every bucket below maxContext, fall back to the max itself.
  assert.equal(bucketNumCtx(4500, 5000), 5000);
  assert.equal(bucketNumCtx(100000, 200000), 131072);
});

test('estimateTokens is a rough ~3.5 chars/token estimate', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens('abcdefg'), Math.ceil(7 / 3.5));
});

test('parseToolCalls extracts well-formed ```tool blocks', () => {
  const text = 'Sure, doing that now.\n```tool\n{"tool": "read_file", "params": {"path": "app.py"}}\n```\n';
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'read_file');
  assert.deepEqual(calls[0].params, { path: 'app.py' });
});

test('parseToolCalls recovers from malformed JSON via regex fallback', () => {
  // Unescaped newline inside the content string, which JSON.parse rejects outright,
  // but Kode's local models produce this constantly.
  const text = '```tool\n{"tool": "create_file", "params": {"path": "x.py", "content": "print(1)\nprint(2)"}}\n```';
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'create_file');
  assert.equal(calls[0].params.path, 'x.py');
});

test('parseToolCalls returns an empty array when there are no tool blocks', () => {
  assert.deepEqual(parseToolCalls('Just a plain text answer, no tools needed.'), []);
});

test('stripToolBlocks removes ```tool blocks from a response', () => {
  const text = 'Here you go:\n```tool\n{"tool":"read_file","params":{"path":"a"}}\n```\nDone.';
  assert.equal(stripToolBlocks(text), 'Here you go:\n\nDone.');
});

test('convertNativeToolCalls handles arguments as a parsed object', () => {
  const native = [{ function: { name: 'read_file', arguments: { path: 'a.py' } } }];
  assert.deepEqual(convertNativeToolCalls(native), [{ tool: 'read_file', params: { path: 'a.py' } }]);
});

test('convertNativeToolCalls handles arguments as a raw JSON string', () => {
  const native = [{ function: { name: 'read_file', arguments: '{"path": "a.py"}' } }];
  assert.deepEqual(convertNativeToolCalls(native), [{ tool: 'read_file', params: { path: 'a.py' } }]);
});

test('convertNativeToolCalls falls back to empty params on unparseable arguments', () => {
  const native = [{ function: { name: 'read_file', arguments: 'not json' } }];
  assert.deepEqual(convertNativeToolCalls(native), [{ tool: 'read_file', params: {} }]);
});

test('convertNativeToolCalls skips entries with no function name', () => {
  assert.deepEqual(convertNativeToolCalls([{ function: {} }, {}]), []);
});

test('AgentCore tracks its active provider, defaulting to ollama', async () => {
  const mockClient = { getContextSize: async () => 8192 };
  const core = new AgentCore(mockClient);
  assert.equal(core.provider, 'ollama');

  core.setProvider('anthropic');
  assert.equal(core.provider, 'anthropic');

  core.setProvider(); // falsy input should be a no-op, not clear the provider
  assert.equal(core.provider, 'anthropic');

  const coreWithProvider = new AgentCore(mockClient, 16384, 'openai');
  assert.equal(coreWithProvider.provider, 'openai');
});

test('AgentCore.setMaxContextCap updates the cap and ignores invalid input', async () => {
  const mockClient = { getContextSize: async () => 8192 };
  const core = new AgentCore(mockClient, 16384);
  assert.equal(core.maxContextCap, 16384);

  core.setMaxContextCap('32768');
  assert.equal(core.maxContextCap, 32768);

  core.setMaxContextCap('not-a-number');
  assert.equal(core.maxContextCap, 32768, 'invalid input should be ignored, not applied');

  core.setMaxContextCap(-5);
  assert.equal(core.maxContextCap, 32768, 'non-positive input should be ignored');
});

test('AgentCore._getContextSize caches per model and respects the configured cap', async () => {
  let calls = 0;
  const mockClient = { getContextSize: async () => { calls++; return 999999; } };
  const core = new AgentCore(mockClient, 16384);

  const size1 = await core._getContextSize('model-a');
  const size2 = await core._getContextSize('model-a');
  assert.equal(size1, 16384);
  assert.equal(size2, 16384);
  assert.equal(calls, 1, 'second call for the same model should hit the cache');
});

test('_getContextSize only applies maxContextCap for the ollama provider, not cloud providers', async () => {
  const mockClient = { getContextSize: async () => 200000 };

  const ollamaCore = new AgentCore(mockClient, 16384, 'ollama');
  assert.equal(await ollamaCore._getContextSize('some-model'), 16384, 'ollama should still be capped for local RAM/VRAM reasons');

  const claudeCore = new AgentCore(mockClient, 16384, 'anthropic');
  assert.equal(await claudeCore._getContextSize('claude-sonnet-5'), 200000, 'cloud providers should get their full reported context, uncapped');
});

test('setProvider clears the context-size cache so a stale capped/uncapped value is not reused', async () => {
  const mockClient = { getContextSize: async () => 200000 };
  const core = new AgentCore(mockClient, 16384, 'ollama');

  assert.equal(await core._getContextSize('model-a'), 16384);
  core.setProvider('anthropic');
  assert.equal(await core._getContextSize('model-a'), 200000, 'switching provider should invalidate the old cached (capped) value');
});

test('_buildContextMessages keeps all history when it fits the budget', async () => {
  const core = new AgentCore({ getContextSize: async () => 16384 }, 16384);
  const systemMessage = { role: 'system', content: 'system prompt' };
  const history = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
  ];
  const messages = await core._buildContextMessages(systemMessage, history, 16384, 'model-a');
  assert.equal(messages.length, 3);
  assert.equal(messages[0], systemMessage);
});

test('processMessage threads onConfirmCommand through to a risky run_command tool call', async () => {
  // A model name/provider combo that does NOT trigger native tool-calling (see
  // prompts.js's supportsNativeToolCalling), so the agent parses the markdown
  // ```tool``` block convention below instead of expecting a structured tool_calls
  // response from the mock client.
  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        // First turn: the model asks to run a risky-but-allowed command.
        return {
          text: '```tool\n{"tool": "run_command", "params": {"command": "echo \\"\\" | base64 -d | bash"}}\n```',
          toolCalls: [],
        };
      }
      // Second turn: after seeing the (blocked) tool result, the model just replies.
      return { text: 'Understood, I will not run that.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  const confirmCalls = [];
  const onConfirmCommand = async (command, label) => {
    confirmCalls.push({ command, label });
    return false; // simulate the user clicking "Block" in the renderer modal
  };

  const result = await core.processMessage(
    'please run that recon script',
    'test-model',
    [],
    () => {},          // onToken
    () => {},          // onToolExecution
    null,               // projectFolder
    () => {},          // onStatus
    onConfirmCommand
  );

  assert.equal(confirmCalls.length, 1, 'expected the confirmation callback to be consulted exactly once');
  assert.match(confirmCalls[0].command, /base64/);
  assert.match(confirmCalls[0].label, /base64/i);

  const runCommandResult = result.toolResults.find(t => t.tool === 'run_command');
  assert.ok(runCommandResult, 'expected a run_command tool result');
  assert.match(runCommandResult.result, /🚫 Blocked.*user declined/i);
});

test('processMessage never consults onConfirmCommand when it is not provided (default/safety-off shape)', async () => {
  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          text: '```tool\n{"tool": "run_command", "params": {"command": "echo hi"}}\n```',
          toolCalls: [],
        };
      }
      return { text: 'Done.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  // No onConfirmCommand arg at all — matches main.js when the Safety toggle is off.
  const result = await core.processMessage('run echo hi', 'test-model', [], () => {}, () => {}, null, () => {});

  const runCommandResult = result.toolResults.find(t => t.tool === 'run_command');
  assert.ok(runCommandResult, 'expected a run_command tool result');
  assert.doesNotMatch(runCommandResult.result, /🚫 Blocked/);
});

test('_buildContextMessages falls back to a tool-name note when summarization fails', async () => {
  const mockClient = {
    getContextSize: async () => 2048,
    abort() {},
    chat: async () => { throw new Error('model unreachable'); },
  };
  const core = new AgentCore(mockClient, 2048);
  const systemMessage = { role: 'system', content: 'sys' };
  const history = [];
  for (let i = 0; i < 20; i++) {
    history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'Tool results:\n[Tool Result: read_file]\n' + 'x'.repeat(300) });
  }
  const messages = await core._buildContextMessages(systemMessage, history, 2048, 'model-a');
  const summaryMsg = messages.find(m => m.role === 'system' && m !== systemMessage);
  assert.ok(summaryMsg, 'expected a fallback context note to be injected');
  assert.match(summaryMsg.content, /Previously completed/);
});
