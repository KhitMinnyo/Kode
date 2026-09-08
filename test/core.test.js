'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const AgentCore = require('../src/agent/core');
const { bucketNumCtx, estimateTokens, parseToolCalls, convertNativeToolCalls, stripToolBlocks, countToolBlockAttempts } = AgentCore._testUtils;

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

test('estimateTokens is a rough ~3.5 chars/token estimate for plain ASCII text', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens('abcdefg'), Math.ceil(7 / 3.5));
});

test('estimateTokens counts non-ASCII text (e.g. Burmese) far more densely than ASCII', () => {
  // Same character count, ASCII vs Burmese — the old flat chars/3.5 heuristic would
  // have returned the same estimate for both, badly under-counting the real token
  // cost of non-Latin scripts that BPE tokenizers weren't heavily trained on.
  const asciiText = 'abcdefghij'; // 10 ASCII chars
  const burmeseText = 'ကျေးဇူးတင်'; // 10 UTF-16 code units of Burmese script
  assert.equal(burmeseText.length, 10);

  const asciiEstimate = estimateTokens(asciiText);
  const burmeseEstimate = estimateTokens(burmeseText);
  assert.ok(burmeseEstimate > asciiEstimate,
    `expected Burmese text to estimate to more tokens than the same-length ASCII text (got ascii=${asciiEstimate}, burmese=${burmeseEstimate})`);
  // Roughly the ~1.2 chars/token calibration for non-ASCII.
  assert.equal(burmeseEstimate, Math.ceil(10 / 1.2));
});

test('estimateTokens handles mixed ASCII/non-ASCII text by weighting each portion separately', () => {
  const mixed = 'hello ကျေးဇူးတင်'; // 6 ASCII chars ("hello ") + 10 Burmese chars
  const expected = Math.ceil(6 / 3.5 + 10 / 1.2);
  assert.equal(estimateTokens(mixed), expected);
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
      // Includes the "✅ Done" marker core.js now looks for so the turn ends here
      // instead of the stall-nudge retrying it (see MAX_STALL_NUDGES in core.js).
      return { text: '✅ Done: understood, I will not run that command.', toolCalls: [] };
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
      return { text: '✅ Done: ran echo hi.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  // No onConfirmCommand arg at all — matches main.js when the Safety toggle is off.
  const result = await core.processMessage('run echo hi', 'test-model', [], () => {}, () => {}, null, () => {});

  const runCommandResult = result.toolResults.find(t => t.tool === 'run_command');
  assert.ok(runCommandResult, 'expected a run_command tool result');
  assert.doesNotMatch(runCommandResult.result, /🚫 Blocked/);
});

test('processMessage threads onAskUser through to an ask_user tool call and feeds the answer back', async () => {
  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        // First turn: the model is genuinely blocked and asks the user directly.
        return {
          text: '```tool\n{"tool": "ask_user", "params": {"question": "Which database should this use?", "options": ["SQLite", "Postgres"]}}\n```',
          toolCalls: [],
        };
      }
      // Second turn: the model has the tool result (the user's answer) in context.
      return { text: '✅ Done: will use Postgres as requested.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  const askCalls = [];
  const onAskUser = async (question, options) => {
    askCalls.push({ question, options });
    return 'Postgres'; // simulate the user clicking the "Postgres" option in the renderer modal
  };

  const result = await core.processMessage(
    'set up the database for this project',
    'test-model',
    [],
    () => {},          // onToken
    () => {},          // onToolExecution
    null,               // projectFolder
    () => {},          // onStatus
    null,               // onConfirmCommand
    onAskUser
  );

  assert.equal(askCalls.length, 1, 'expected the ask-user callback to be consulted exactly once');
  assert.equal(askCalls[0].question, 'Which database should this use?');
  assert.deepEqual(askCalls[0].options, ['SQLite', 'Postgres']);

  const askResult = result.toolResults.find(t => t.tool === 'ask_user');
  assert.ok(askResult, 'expected an ask_user tool result');
  assert.match(askResult.result, /User answered: Postgres/);
  assert.match(result.response, /Postgres/);
});

test('processMessage reports ask_user as unavailable (not a hang) when onAskUser is not provided', async () => {
  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          text: '```tool\n{"tool": "ask_user", "params": {"question": "Which database should this use?"}}\n```',
          toolCalls: [],
        };
      }
      return { text: '✅ Done: proceeded without an answer.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  // No onAskUser arg — matches processMessage being driven with no UI to ask through.
  const result = await core.processMessage('set up the database', 'test-model', [], () => {}, () => {}, null, () => {});

  const askResult = result.toolResults.find(t => t.tool === 'ask_user');
  assert.ok(askResult, 'expected an ask_user tool result');
  assert.match(askResult.result, /unavailable/i);
});

test('setToolApiKeys sets firecrawlApiKey/braveSearchApiKey, defaulting to empty strings', () => {
  const mockClient = { getContextSize: async () => 8192 };
  const core = new AgentCore(mockClient, 8192, 'ollama');

  // Defaults before any configuration — always defined so toolContext never carries undefined.
  assert.equal(core.firecrawlApiKey, '');
  assert.equal(core.braveSearchApiKey, '');

  core.setToolApiKeys({ firecrawlApiKey: 'fc-abc', braveSearchApiKey: 'brave-xyz' });
  assert.equal(core.firecrawlApiKey, 'fc-abc');
  assert.equal(core.braveSearchApiKey, 'brave-xyz');

  // Partial update — only the given key changes, the other is left as-is.
  core.setToolApiKeys({ firecrawlApiKey: 'fc-updated' });
  assert.equal(core.firecrawlApiKey, 'fc-updated');
  assert.equal(core.braveSearchApiKey, 'brave-xyz');

  // A non-string/missing field is ignored rather than overwriting with garbage.
  core.setToolApiKeys({});
  assert.equal(core.firecrawlApiKey, 'fc-updated');
});

test('processMessage threads setToolApiKeys-configured keys into the web_search tool via toolContext (not env vars)', async () => {
  const originalFetch = global.fetch;
  const originalEnvKey = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY; // prove the key came from Settings, not the environment

  let seenToken = null;
  global.fetch = async (url, options) => {
    seenToken = options && options.headers && options.headers['X-Subscription-Token'];
    return { ok: true, json: async () => ({ web: { results: [{ title: 'Result', url: 'https://x.test', description: 'desc' }] } }) };
  };

  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return { text: '```tool\n{"tool": "web_search", "params": {"query": "latest CVE"}}\n```', toolCalls: [] };
      }
      return { text: '✅ Done searching.', toolCalls: [] };
    },
  };

  try {
    const core = new AgentCore(mockClient, 8192, 'ollama');
    core.setToolApiKeys({ braveSearchApiKey: 'settings-configured-brave-key' });

    const result = await core.processMessage('search for the latest CVE', 'test-model', [], () => {}, () => {}, null, () => {});

    assert.equal(seenToken, 'settings-configured-brave-key');
    const searchResult = result.toolResults.find(t => t.tool === 'web_search');
    assert.ok(searchResult, 'expected a web_search tool result');
    assert.match(searchResult.result, /Result/);
  } finally {
    global.fetch = originalFetch;
    if (originalEnvKey !== undefined) process.env.BRAVE_SEARCH_API_KEY = originalEnvKey;
  }
});

test('_scanProjectContext caches its result and reuses it (without rescanning) when the folder is unchanged', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-scancache-test-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);');

  const mockClient = { getContextSize: async () => 8192 };
  const core = new AgentCore(mockClient, 8192, 'anthropic'); // non-ollama: no embed client, keeps this test focused on caching

  const first = await core._scanProjectContext(dir);
  assert.match(first, /app\.js/);
  assert.ok(core._projectScanCache[dir], 'expected the scan to populate the cache');

  // Prove the SECOND call is a genuine cache hit (not just a rescan landing on the
  // same string) by counting fs.readdirSync calls: _projectScanFingerprint alone
  // calls it once (to check whether anything changed); a full rescan additionally
  // calls it again for the top-level listing. A cache hit should only ever incur the
  // fingerprint's single call.
  const realReaddirSync = fs.readdirSync;
  let readdirCalls = 0;
  fs.readdirSync = (...args) => { readdirCalls++; return realReaddirSync(...args); };
  try {
    const second = await core._scanProjectContext(dir);
    assert.equal(second, first, 'expected the cached context to be reused verbatim');
    assert.equal(readdirCalls, 1, 'expected only the fingerprint check to run readdirSync on a cache hit (no full rescan)');
  } finally {
    fs.readdirSync = realReaddirSync;
  }
});

test('_scanProjectContext rescans once the project folder actually changes (fingerprint mismatch)', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-scancache-test-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);');

  const mockClient = { getContextSize: async () => 8192 };
  const core = new AgentCore(mockClient, 8192, 'anthropic');

  const first = await core._scanProjectContext(dir);
  assert.match(first, /app\.js/);
  assert.doesNotMatch(first, /new-file\.js/);

  // Add a new file — the top-level fingerprint (names+mtimes) now differs, so this
  // must be treated as a real change and rescanned rather than serving the stale cache.
  fs.writeFileSync(path.join(dir, 'new-file.js'), 'console.log(2);');

  const second = await core._scanProjectContext(dir);
  assert.match(second, /new-file\.js/, 'expected the rescan to pick up the newly added file');
  assert.notEqual(second, first);
});

test('_projectScanFingerprint fails soft (returns null) for a folder that does not exist', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const mockClient = { getContextSize: async () => 8192 };
  const core = new AgentCore(mockClient, 8192, 'anthropic');
  assert.equal(core._projectScanFingerprint('/no/such/directory/at/all', fs, path), null);
});

test('_scanProjectContext persists a project-structure memory entry with no vector when no Ollama embed client is available', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const memory = require('../src/agent/memory');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-scancache-test-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);');

  const mockClient = { getContextSize: async () => 8192 };
  const core = new AgentCore(mockClient, 8192, 'anthropic'); // non-ollama provider: no embed client available

  await core._scanProjectContext(dir);

  const saved = memory.loadMemory(dir);
  const entry = saved.entries.find(e => e.key === 'project-structure');
  assert.ok(entry, 'expected a project-structure memory entry to be saved');
  assert.match(entry.value, /app\.js/);
  assert.deepEqual(entry.tags, ['project-analysis']);
  assert.equal(entry.vector, null);
});

test('_scanProjectContext embeds the persisted project-structure entry when an Ollama embed client is available', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const memory = require('../src/agent/memory');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-scancache-test-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);');

  let embedCalls = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    embed: async () => { embedCalls++; return [[0.1, 0.2, 0.3]]; },
  };
  const core = new AgentCore(mockClient, 8192, 'ollama');

  await core._scanProjectContext(dir);

  assert.equal(embedCalls, 1, 'expected the project scan to be embedded exactly once');
  const saved = memory.loadMemory(dir);
  const entry = saved.entries.find(e => e.key === 'project-structure');
  assert.ok(entry);
  assert.deepEqual(entry.vector, [0.1, 0.2, 0.3]);
});

test('_scanProjectContext still saves (without a vector) if embedding the scan throws', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const memory = require('../src/agent/memory');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-scancache-test-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);');

  const mockClient = {
    getContextSize: async () => 8192,
    embed: async () => { throw new Error('embedding service unreachable'); },
  };
  const core = new AgentCore(mockClient, 8192, 'ollama');

  // Should not throw or block the scan itself.
  const context = await core._scanProjectContext(dir);
  assert.match(context, /app\.js/);

  const saved = memory.loadMemory(dir);
  const entry = saved.entries.find(e => e.key === 'project-structure');
  assert.ok(entry, 'expected the entry to still be saved despite the embedding failure');
  assert.equal(entry.vector, null);
});

test('processMessage auto-recall prefers semantic memory search over keyword search, catching a rephrased query keyword search would miss', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const memory = require('../src/agent/memory');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-semrecall-test-'));
  // Seed a memory entry whose key/value/tags share NO words with the question below —
  // keyword search (word-overlap) would find nothing, so only semantic search (cosine
  // similarity over the fake embedding vectors) can surface it.
  memory.upsertMemoryEntry(dir, 'auth-approach', 'We use JWT bearer tokens for API authentication.', ['architecture'], [1, 0, 0]);

  let capturedMessages = null;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    embed: async () => [[1, 0, 0.01]], // closest to the seeded vector above
    chat: async (model, messages) => {
      capturedMessages = messages;
      return { text: 'Sure.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  await core.processMessage('how do users log in to the api?', 'test-model', [], () => {}, () => {}, dir, () => {});

  assert.ok(capturedMessages, 'expected chat() to have been called');
  const lastUserMessage = [...capturedMessages].reverse().find(m => m.role === 'user');
  assert.ok(lastUserMessage, 'expected a user message in the built context');
  assert.match(lastUserMessage.content, /Relevant project memory/);
  assert.match(lastUserMessage.content, /JWT bearer tokens/);
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

test('_buildContextMessages caches the full text of dropped history to .kode/scratch/ when a project folder is active', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-test-'));

  const mockClient = {
    getContextSize: async () => 2048,
    abort() {},
    chat: async () => { throw new Error('model unreachable'); }, // exercise the fallback path
  };
  const core = new AgentCore(mockClient, 2048);
  const systemMessage = { role: 'system', content: 'sys' };
  const history = [];
  for (let i = 0; i < 20; i++) {
    history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'Tool results:\n[Tool Result: read_file]\n' + `unique-marker-${i}-` + 'x'.repeat(300) });
  }

  const messages = await core._buildContextMessages(systemMessage, history, 2048, 'model-a', dir);
  const summaryMsg = messages.find(m => m.role === 'system' && m !== systemMessage);
  assert.ok(summaryMsg, 'expected a fallback context note to be injected');
  assert.match(summaryMsg.content, /saved to \.kode\/scratch\//);

  const scratchDir = path.join(dir, '.kode', 'scratch');
  const files = fs.readdirSync(scratchDir);
  assert.equal(files.length, 1);
  const saved = fs.readFileSync(path.join(scratchDir, files[0]), 'utf-8');
  // The exact original content (not just a paraphrase) should be recoverable.
  assert.match(saved, /unique-marker-0-/);
});

test('_buildContextMessages does not create a scratch file for a small drop not worth caching', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-test-'));

  const mockClient = {
    getContextSize: async () => 250,
    abort() {},
    chat: async () => { throw new Error('model unreachable'); },
  };
  const core = new AgentCore(mockClient, 250);
  const systemMessage = { role: 'system', content: 'sys' };
  // _buildContextMessages floors its budget at 200 tokens (~700 ASCII chars) no
  // matter how small contextSize is, so enough short messages to exceed that (but
  // whose oldest, dropped few stay well under the 1500-char scratch threshold) is
  // what actually exercises "a drop happened, but it wasn't worth a scratch file" —
  // an arbitrarily tiny contextSize alone does NOT force a drop.
  const history = [];
  for (let i = 0; i < 30; i++) {
    history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `short message number ${i}` });
  }

  const messages = await core._buildContextMessages(systemMessage, history, 250, 'model-a', dir);
  assert.ok(messages.length < history.length + 1, 'expected this budget to actually drop something, or the test proves nothing');
  assert.ok(!fs.existsSync(path.join(dir, '.kode', 'scratch')), 'expected no scratch file for a small drop');
});

test('_buildContextMessages persists a generated summary to .kode/context-cache.json, and a fresh AgentCore instance reuses it instead of re-summarizing', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const contextCache = require('../src/agent/contextCache');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-test-'));

  const mockClient1 = {
    getContextSize: async () => 2048,
    abort() {},
    chat: async () => ({ text: 'DISTINCTIVE-SUMMARY-abc123: user is refactoring the auth module.', toolCalls: [] }),
  };
  const core1 = new AgentCore(mockClient1, 2048);
  const systemMessage = { role: 'system', content: 'sys' };
  const history = [];
  for (let i = 0; i < 20; i++) {
    history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'Tool results:\n[Tool Result: read_file]\n' + 'x'.repeat(300) });
  }

  const messages1 = await core1._buildContextMessages(systemMessage, history, 2048, 'model-a', dir);
  const summaryMsg1 = messages1.find(m => m.role === 'system' && m !== systemMessage);
  assert.ok(summaryMsg1, 'expected a summary message to be injected');
  assert.match(summaryMsg1.content, /DISTINCTIVE-SUMMARY-abc123/);

  // It should have been persisted to disk under this conversation's fingerprint.
  const fingerprint = core1._conversationFingerprint('model-a', history);
  const onDisk = contextCache.getEntry(dir, fingerprint);
  assert.ok(onDisk, 'expected the summary to be persisted to .kode/context-cache.json');
  assert.match(onDisk.summary, /DISTINCTIVE-SUMMARY-abc123/);

  // A brand-new AgentCore instance (simulating an app restart, or a fresh tab picking
  // up the same conversation) has an empty in-memory cache — if it had to regenerate
  // the summary it would call chat() again, which this mock makes throw. Getting the
  // ORIGINAL summary text back proves it was read from disk instead.
  const mockClient2 = {
    getContextSize: async () => 2048,
    abort() {},
    chat: async () => { throw new Error('should not be called — must reuse the on-disk cache'); },
  };
  const core2 = new AgentCore(mockClient2, 2048);
  const messages2 = await core2._buildContextMessages(systemMessage, history, 2048, 'model-a', dir);
  const summaryMsg2 = messages2.find(m => m.role === 'system' && m !== systemMessage);
  assert.ok(summaryMsg2, 'expected the fresh instance to still inject a summary message');
  assert.match(summaryMsg2.content, /DISTINCTIVE-SUMMARY-abc123/, 'expected the fresh instance to reuse the cached summary rather than fail or fall back');
});

test('_buildContextMessages still generates a summary normally when no project folder is active (the on-disk cache is simply skipped)', async () => {
  const mockClient = {
    getContextSize: async () => 2048,
    abort() {},
    chat: async () => ({ text: 'a summary with no project folder involved', toolCalls: [] }),
  };
  const core = new AgentCore(mockClient, 2048);
  const systemMessage = { role: 'system', content: 'sys' };
  const history = [];
  for (let i = 0; i < 20; i++) {
    history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'Tool results:\n[Tool Result: read_file]\n' + 'x'.repeat(300) });
  }

  // No projectFolder argument at all.
  const messages = await core._buildContextMessages(systemMessage, history, 2048, 'model-a');
  const summaryMsg = messages.find(m => m.role === 'system' && m !== systemMessage);
  assert.ok(summaryMsg, 'expected a summary message to still be injected without a project folder');
  assert.match(summaryMsg.content, /a summary with no project folder involved/);
});

test('_executeToolCalls runs consecutive read-only tool calls concurrently, not one at a time', async () => {
  const toolsModule = require('../src/agent/tools');
  const originalReadFile = toolsModule.read_file;
  const originalListDirectory = toolsModule.list_directory;
  const originalSearchFiles = toolsModule.search_files;
  const DELAY_MS = 60;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Three tools that would each take DELAY_MS if awaited one at a time (~3x DELAY_MS
  // total) but should overlap almost entirely if actually run concurrently.
  toolsModule.read_file = async () => { await sleep(DELAY_MS); return 'read_file done'; };
  toolsModule.list_directory = async () => { await sleep(DELAY_MS); return 'list_directory done'; };
  toolsModule.search_files = async () => { await sleep(DELAY_MS); return 'search_files done'; };

  try {
    const core = new AgentCore({ getContextSize: async () => 8192, abort() {} }, 8192);
    core._isGenerating = true; // normally set by processMessage; calling _executeToolCalls directly here
    const toolCalls = [
      { tool: 'read_file', params: {} },
      { tool: 'list_directory', params: {} },
      { tool: 'search_files', params: {} },
    ];
    const start = Date.now();
    const results = await core._executeToolCalls(toolCalls, null, {}, () => {}, () => {});
    const elapsed = Date.now() - start;

    assert.equal(results.length, 3);
    assert.deepEqual(results.map(r => r.result), ['read_file done', 'list_directory done', 'search_files done']);
    // Sequential execution would take roughly 3 * DELAY_MS (180ms+); concurrent
    // execution should land close to a single DELAY_MS. Generous margin for CI jitter.
    assert.ok(elapsed < DELAY_MS * 2, `expected concurrent execution (<${DELAY_MS * 2}ms), took ${elapsed}ms`);
  } finally {
    toolsModule.read_file = originalReadFile;
    toolsModule.list_directory = originalListDirectory;
    toolsModule.search_files = originalSearchFiles;
  }
});

test('_executeToolCalls preserves the original request order in its results, even when a batch finishes out of order', async () => {
  const toolsModule = require('../src/agent/tools');
  const originalReadFile = toolsModule.read_file;
  const originalListDirectory = toolsModule.list_directory;

  // read_file (requested first) finishes LAST; list_directory (requested second)
  // finishes FIRST — results/callbacks should still come back in request order.
  toolsModule.read_file = async () => { await new Promise((resolve) => setTimeout(resolve, 40)); return 'slow read_file result'; };
  toolsModule.list_directory = async () => 'fast list_directory result';

  try {
    const core = new AgentCore({ getContextSize: async () => 8192, abort() {} }, 8192);
    core._isGenerating = true;
    const toolCalls = [
      { tool: 'read_file', params: {} },
      { tool: 'list_directory', params: {} },
    ];
    const executedOrder = [];
    const results = await core._executeToolCalls(toolCalls, null, {}, () => {}, (exec) => executedOrder.push(exec.tool));

    assert.deepEqual(results.map(r => r.tool), ['read_file', 'list_directory']);
    assert.deepEqual(executedOrder, ['read_file', 'list_directory'], 'onToolExecution should fire in request order too');
  } finally {
    toolsModule.read_file = originalReadFile;
    toolsModule.list_directory = originalListDirectory;
  }
});

test('_executeToolCalls never batches a side-effecting call with a read — a later read sees the write\'s effect', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-test-'));
  const core = new AgentCore({ getContextSize: async () => 8192, abort() {} }, 8192);
  core._isGenerating = true;
  const toolCalls = [
    { tool: 'create_file', params: { path: 'note.txt', content: 'hello from create_file' } },
    { tool: 'read_file', params: { path: 'note.txt' } },
  ];
  const results = await core._executeToolCalls(toolCalls, dir, {}, () => {}, () => {});
  assert.equal(results.length, 2);
  assert.equal(results[0].tool, 'create_file');
  assert.equal(results[1].tool, 'read_file');
  assert.match(results[1].result, /hello from create_file/);
});

test('_executeToolCalls catches one failing tool without failing the rest of its batch', async () => {
  const toolsModule = require('../src/agent/tools');
  const originalReadFile = toolsModule.read_file;
  toolsModule.read_file = async () => { throw new Error('boom'); };

  try {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-test-'));
    const core = new AgentCore({ getContextSize: async () => 8192, abort() {} }, 8192);
    core._isGenerating = true;
    const toolCalls = [
      { tool: 'read_file', params: { path: 'nope.txt' } },
      { tool: 'list_directory', params: { path: '.' } },
    ];
    const results = await core._executeToolCalls(toolCalls, dir, {}, () => {}, () => {});
    assert.equal(results.length, 2, 'expected both calls to still produce a result');
    assert.match(results[0].result, /Tool execution error \(read_file\): boom/);
    assert.doesNotMatch(results[1].result, /Tool execution error/);
  } finally {
    toolsModule.read_file = originalReadFile;
  }
});

test('_executeToolCalls reports an unknown tool name without throwing, same as before batching existed', async () => {
  const core = new AgentCore({ getContextSize: async () => 8192, abort() {} }, 8192);
  core._isGenerating = true;
  const results = await core._executeToolCalls([{ tool: 'not_a_real_tool', params: {} }], null, {}, () => {}, () => {});
  assert.equal(results.length, 1);
  assert.match(results[0].result, /Unknown tool: "not_a_real_tool"/);
});

test('_executeToolCalls stops dispatching further batches once _isGenerating goes false (Stop button)', async () => {
  const core = new AgentCore({ getContextSize: async () => 8192, abort() {} }, 8192);
  core._isGenerating = false; // simulate Stop having already been pressed
  const results = await core._executeToolCalls([{ tool: 'read_file', params: { path: 'x.txt' } }], null, {}, () => {}, () => {});
  assert.deepEqual(results, []);
});

test('countToolBlockAttempts counts ```tool blocks regardless of whether the JSON parses', () => {
  assert.equal(countToolBlockAttempts('no blocks here'), 0);
  assert.equal(countToolBlockAttempts('```tool\n{"tool": "read_file", "params": {}}\n```'), 1);
  assert.equal(countToolBlockAttempts('```tool\nnot even json\n```\n```tool\n{"tool":"x","params":{}}\n```'), 2);
});

test('processMessage asks the model to retry when a ```tool block is unparseable, instead of silently dropping it', async () => {
  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        // A ```tool block that even the regex-recovery strategies in tryParseToolJSON
        // can't salvage (no "tool" key at all) — previously this just vanished with
        // toolCalls.length === 0, ending the turn as if nothing had been attempted.
        return { text: '```tool\nthis is not json and has no tool field\n```', toolCalls: [] };
      }
      if (chatCallCount === 2) {
        return { text: 'Got it, retrying.\n```tool\n{"tool": "read_file", "params": {"path": "a.py"}}\n```', toolCalls: [] };
      }
      // Includes the "✅ Done" marker core.js now looks for after a tool call, so the
      // turn ends here in one shot rather than the stall-nudge retrying it (see
      // MAX_STALL_NUDGES in core.js).
      return { text: '✅ Done: read a.py.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  const result = await core.processMessage('read a.py', 'test-model', [], () => {}, () => {}, null, () => {});

  // Should have retried (3 chat calls) rather than ending after the first malformed block.
  assert.equal(chatCallCount, 3);
  const readResult = result.toolResults.find(t => t.tool === 'read_file');
  assert.ok(readResult, 'expected read_file to eventually run after the retry');
});

test('processMessage threads the ollamaClient/embedClient into toolContext for semantic-search tools', async () => {
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    embed: async () => [[1, 0]],
    chat: async (model, messages, onChunk, opts) => {
      // First turn: call semantic_search, which needs toolContext.ollamaClient wired
      // through from AgentCore for the "requires the Ollama provider" check to pass.
      if (!messages.some(m => m.role === 'user' && m.content.startsWith('Tool results:'))) {
        return { text: '```tool\n{"tool": "semantic_search", "params": {"query": "auth"}}\n```', toolCalls: [] };
      }
      return { text: '✅ Done: found the auth code.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  const result = await core.processMessage('find the auth code', 'test-model', [], () => {}, () => {}, null, () => {});

  const searchResult = result.toolResults.find(t => t.tool === 'semantic_search');
  assert.ok(searchResult, 'expected semantic_search to have run');
  // Should NOT hit the "requires the Ollama provider" error, since embedClient was wired through.
  assert.doesNotMatch(searchResult.result, /requires the Ollama provider/);
});

test('processMessage gives up gracefully when the client stalls repeatedly with no response at all', async () => {
  // Every call comes back empty with stalled: true (as Ollama/DeepSeek/OpenAI/Anthropic/
  // Custom clients now report — see the shared armStallTimeout/_abortReason pattern in
  // each client). Without stall-awareness this used to just retry the generic "Please
  // proceed with the task" nudge up to MAX_TOOL_ITERATIONS times; it should instead give
  // up after MAX_STALL_NUDGES (3) attempts with a clear message.
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
  const result = await core.processMessage('do something', 'test-model', [], () => {}, () => {}, null, () => {});

  assert.equal(chatCallCount, 4, 'expected 3 stall-nudge retries plus 1 final give-up, not a full MAX_TOOL_ITERATIONS loop');
  assert.match(result.response, /stalled repeatedly/i);
});

test('processMessage nudges on a stalled-but-nonempty response even before any tool work, then gives up', async () => {
  // A stall can abort mid-stream after some text already arrived, with no tool calls —
  // that used to look identical to a legitimately finished plain-text answer (the
  // "no tool calls attempted, allToolResults.length === 0" exemption). It must still be
  // nudged/retried when chatResult.stalled is true, regardless of allToolResults.
  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async () => {
      chatCallCount++;
      return { text: 'partial output before the connection stalled', toolCalls: [], stalled: true };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  const result = await core.processMessage('do something', 'test-model', [], () => {}, () => {}, null, () => {});

  assert.equal(chatCallCount, 4, 'expected 3 stall-nudge retries plus 1 final give-up');
  assert.match(result.response, /kept stalling/i);
  assert.match(result.response, /partial output before the connection stalled/);
});

test('processMessage nudges a stall that happens after real tool work, then gives up with the partial text preserved', async () => {
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
      return { text: 'still summarizing the result', toolCalls: [], stalled: true };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  const result = await core.processMessage('run echo hi', 'test-model', [], () => {}, () => {}, null, () => {});

  // 1 tool-call turn + 3 stall-nudge retries + 1 final give-up
  assert.equal(chatCallCount, 5);
  assert.match(result.response, /kept stalling/i);

  const runCommandResult = result.toolResults.find(t => t.tool === 'run_command');
  assert.ok(runCommandResult, 'expected run_command to have actually run before the stall');
});

test('processMessage labels a user-initiated Stop distinctly from a stall in the final response', async () => {
  // stopGeneration() sets _isGenerating = false, which processMessage checks right
  // after each chat() call returns. Simulate the user clicking Stop mid-turn by
  // flipping that flag from inside the mock client itself.
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async () => {
      core.stopGeneration();
      return { text: 'partial answer before the user hit stop', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  const result = await core.processMessage('do something', 'test-model', [], () => {}, () => {}, null, () => {});

  assert.match(result.response, /⏹️ Stopped\./);
  assert.match(result.response, /partial answer before the user hit stop/);
  // Must not be confused with the stall give-up wording.
  assert.doesNotMatch(result.response, /kept stalling/i);
});

test('processMessage stops gracefully after MAX_TOOL_ITERATIONS with a clear message, instead of silently truncating', async () => {
  // The model keeps calling a tool forever and never says "✅ Done" — simulates a task
  // that's still making real progress each iteration but never wraps up within the
  // iteration safety limit (see MAX_TOOL_ITERATIONS in core.js, currently 25).
  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async (model, messages) => {
      // _buildContextMessages can summarize dropped history via its own one-shot
      // chat() call (a single user message) once history grows large enough across 25
      // iterations — distinct from the main loop's calls, which always pass the full
      // system+history messages array. Answer it with plain text and don't count it
      // toward the iteration-loop assertions below.
      if (messages.length === 1 && messages[0].role === 'user') {
        return { text: 'summary of earlier steps', toolCalls: [] };
      }
      chatCallCount++;
      return {
        text: `\`\`\`tool\n{"tool": "run_command", "params": {"command": "echo step ${chatCallCount}"}}\n\`\`\``,
        toolCalls: [],
      };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  const result = await core.processMessage('do an endless task', 'test-model', [], () => {}, () => {}, null, () => {});

  assert.equal(chatCallCount, 25, 'expected exactly MAX_TOOL_ITERATIONS main-loop chat calls');
  assert.equal(result.toolResults.length, 25, 'expected a tool call on every one of the 25 iterations');
  assert.match(result.response, /safety limit/i);
});

test('processMessage does not add a safety-limit message when the task finishes normally within the iteration budget', async () => {
  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return { text: '```tool\n{"tool": "run_command", "params": {"command": "echo hi"}}\n```', toolCalls: [] };
      }
      return { text: '✅ Done: ran echo hi.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  const result = await core.processMessage('run echo hi', 'test-model', [], () => {}, () => {}, null, () => {});

  assert.doesNotMatch(result.response, /safety limit/i);
  assert.match(result.response, /✅ Done/);
});

// ─── Post-"✅ Done" verification (_verifyDoneClaim) ──────────────────────────

test('processMessage nudges when a syntax check on a just-written file fails after "✅ Done", then accepts once fixed', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-test-'));

  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async (model, messages) => {
      if (messages.length === 1 && messages[0].role === 'user') {
        return { text: 'summary', toolCalls: [] }; // context-summarization call, ignore
      }
      chatCallCount++;
      if (chatCallCount === 1) {
        // Write a JS file with a real syntax error (unbalanced brace).
        return {
          text: '```tool\n{"tool": "create_file", "params": {"path": "broken.js", "content": "function broken( {"}}\n```',
          toolCalls: [],
        };
      }
      if (chatCallCount === 2) {
        // Claims done without actually fixing anything.
        return { text: '✅ Done: wrote broken.js.', toolCalls: [] };
      }
      if (chatCallCount === 3) {
        // Responds to the nudge by fixing the file.
        return {
          text: '```tool\n{"tool": "create_file", "params": {"path": "broken.js", "content": "function fixed() {}\\n"}}\n```',
          toolCalls: [],
        };
      }
      return { text: '✅ Done: fixed the syntax error.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  const result = await core.processMessage('write broken.js', 'test-model', [], () => {}, () => {}, dir, () => {});

  assert.equal(chatCallCount, 4, 'expected the nudge to trigger one extra fix-it round trip');
  assert.match(result.response, /✅ Done: fixed the syntax error/);
  assert.doesNotMatch(result.response, /Automatic verification/);
  assert.equal(fs.readFileSync(path.join(dir, 'broken.js'), 'utf-8'), 'function fixed() {}\n');
});

test('processMessage reports (rather than silently accepting) a verification failure that survives MAX_VERIFY_NUDGES attempts', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-test-'));

  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async (model, messages) => {
      if (messages.length === 1 && messages[0].role === 'user') {
        return { text: 'summary', toolCalls: [] };
      }
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          text: '```tool\n{"tool": "create_file", "params": {"path": "broken.js", "content": "function broken( {"}}\n```',
          toolCalls: [],
        };
      }
      // Keeps claiming done without ever actually fixing the file.
      return { text: '✅ Done: should be fine now.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  const result = await core.processMessage('write broken.js', 'test-model', [], () => {}, () => {}, dir, () => {});

  assert.match(result.response, /Automatic verification/);
  assert.match(result.response, /broken\.js/);
});

test('processMessage does not run the project test suite when there is no real test script', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'temp', version: '1.0.0',
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
  }));

  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async (model, messages) => {
      if (messages.length === 1 && messages[0].role === 'user') return { text: 'summary', toolCalls: [] };
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          text: '```tool\n{"tool": "create_file", "params": {"path": "ok.js", "content": "function ok() {}\\n"}}\n```',
          toolCalls: [],
        };
      }
      return { text: '✅ Done: wrote ok.js.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  const result = await core.processMessage('write ok.js', 'test-model', [], () => {}, () => {}, dir, () => {});

  // Should finish clean on the first "Done" claim — no npm-init placeholder script
  // should ever get invoked as if it were real.
  assert.equal(chatCallCount, 2);
  assert.match(result.response, /✅ Done: wrote ok\.js/);
});

test('processMessage catches a real test-suite failure after "✅ Done" and reports it', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'temp', version: '1.0.0',
    scripts: { test: 'exit 1' },
  }));

  let chatCallCount = 0;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async (model, messages) => {
      if (messages.length === 1 && messages[0].role === 'user') return { text: 'summary', toolCalls: [] };
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          text: '```tool\n{"tool": "create_file", "params": {"path": "ok.js", "content": "function ok() {}\\n"}}\n```',
          toolCalls: [],
        };
      }
      return { text: '✅ Done: wrote ok.js.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  const result = await core.processMessage('write ok.js', 'test-model', [], () => {}, () => {}, dir, () => {});

  assert.match(result.response, /test suite failed/i);
});
