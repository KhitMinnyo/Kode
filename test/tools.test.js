'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tools = require('../src/agent/tools');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kode-test-'));
}

test('create_file writes content and creates parent directories', async () => {
  const dir = makeTempDir();
  const result = await tools.create_file({ path: 'nested/dir/hello.txt', content: 'hi there' }, dir);
  assert.match(result, /✅/);
  const written = fs.readFileSync(path.join(dir, 'nested/dir/hello.txt'), 'utf-8');
  assert.equal(written, 'hi there');
});

test('create_file requires path and content', async () => {
  const dir = makeTempDir();
  assert.match(await tools.create_file({ content: 'x' }, dir), /path.*required/i);
  assert.match(await tools.create_file({ path: 'a.txt' }, dir), /content.*required/i);
});

test('edit_file replaces an exact match and reports occurrence count', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'foo bar foo');
  const result = await tools.edit_file({ path: 'a.txt', old_content: 'foo', new_content: 'baz' }, dir);
  assert.match(result, /✅/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8'), 'baz bar baz');
});

test('edit_file reports a clear error when old_content is not found', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello world');
  const result = await tools.edit_file({ path: 'a.txt', old_content: 'missing', new_content: 'x' }, dir);
  assert.match(result, /❌.*Could not find/);
});

test('edit_file reports a clear error for a nonexistent file', async () => {
  const dir = makeTempDir();
  const result = await tools.edit_file({ path: 'nope.txt', old_content: 'a', new_content: 'b' }, dir);
  assert.match(result, /❌.*not found/);
});

test('read_file returns file contents with a size header', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello world');
  const result = await tools.read_file({ path: 'a.txt' }, dir);
  assert.match(result, /hello world/);
});

test('read_file refuses to read a directory', async () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'subdir'));
  const result = await tools.read_file({ path: 'subdir' }, dir);
  assert.match(result, /is a directory/);
});

test('read_file with offset/limit returns only the requested line range, numbered', async () => {
  const dir = makeTempDir();
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(path.join(dir, 'many.txt'), lines.join('\n'));

  const result = await tools.read_file({ path: 'many.txt', offset: 5, limit: 3 }, dir);
  assert.match(result, /lines 5-7 of 20/);
  assert.match(result, /5\tline 5/);
  assert.match(result, /6\tline 6/);
  assert.match(result, /7\tline 7/);
  assert.doesNotMatch(result, /\bline 4\b/);
  assert.doesNotMatch(result, /\bline 8\b/);
  assert.match(result, /13 more line\(s\) below — pass offset: 8 to continue/);
});

test('read_file with only offset (no limit) defaults to a 2000-line window and omits the "more" hint once it reaches the end', async () => {
  const dir = makeTempDir();
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(path.join(dir, 'short.txt'), lines.join('\n'));

  const result = await tools.read_file({ path: 'short.txt', offset: 3 }, dir);
  assert.match(result, /lines 3-10 of 10/);
  assert.match(result, /3\tline 3/);
  assert.match(result, /10\tline 10/);
  assert.doesNotMatch(result, /more line\(s\) below/);
});

test('read_file with an offset past the end of the file returns a clear error', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'small.txt'), 'a\nb\nc');
  const result = await tools.read_file({ path: 'small.txt', offset: 50 }, dir);
  assert.match(result, /❌.*past the end/);
});

test('read_file without offset/limit keeps the old whole-file-or-first-50KB behavior', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'plain.txt'), 'line 1\nline 2\nline 3');
  const result = await tools.read_file({ path: 'plain.txt' }, dir);
  assert.match(result, /line 1\nline 2\nline 3/); // unnumbered, full content, no range header
  assert.doesNotMatch(result, /showing lines/);
});

test('list_directory lists files and folders', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'sub'));
  const result = await tools.list_directory({ path: '.' }, dir);
  assert.match(result, /a\.txt/);
  assert.match(result, /sub\//);
});

test('search_files finds a pattern across files', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.py'), 'def foo():\n    TODO_MARKER = 1\n');
  const result = await tools.search_files({ pattern: 'TODO_MARKER' }, dir);
  assert.match(result, /a\.py/);
});

test('security_audit requires an active project folder', async () => {
  const result = await tools.security_audit({}, null);
  assert.match(result, /requires an active project folder/);
});

test('security_audit reports no findings for a clean project', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'app.js'), 'function add(a, b) {\n  return a + b;\n}\n');
  const result = await tools.security_audit({}, dir);
  assert.match(result, /no pattern-matched issues found/);
});

test('security_audit detects a hardcoded credential and redacts the actual secret value', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'config.js'), "const apiKey = \"sk_abcdefghijklmnopqrstuvwxyz123456\";\n");
  const result = await tools.security_audit({}, dir);
  assert.match(result, /hardcoded-secret/);
  assert.match(result, /config\.js:1/);
  assert.doesNotMatch(result, /sk_abcdefghijklmnopqrstuvwxyz123456/, 'the raw secret value must never appear in the report');
  assert.match(result, /\*{4,}/, 'expected the redacted value to show masking asterisks');
});

test('security_audit detects an AWS access key literal', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, '.env'), 'AWS_KEY=AKIAABCDEFGHIJKLMNOP\n');
  const result = await tools.security_audit({}, dir);
  assert.match(result, /hardcoded-secret/);
  assert.doesNotMatch(result, /AKIAABCDEFGHIJKLMNOP/);
});

test('security_audit scans .env files even though dotfiles are skipped generally', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=abcdefghijklmnopqrstuvwx\n');
  fs.mkdirSync(path.join(dir, '.hidden-dir'));
  fs.writeFileSync(path.join(dir, '.hidden-dir', 'x.js'), 'const apiKey = "abcdefghijklmnopqrstuvwx";\n');
  const result = await tools.security_audit({}, dir);
  assert.match(result, /\.env:1/, 'expected .env to be scanned');
  assert.doesNotMatch(result, /\.hidden-dir/, 'expected an unrelated dot-directory to still be skipped');
});

test('security_audit detects eval() as a code-injection sink', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'app.js'), 'function run(userInput) {\n  return eval(userInput);\n}\n');
  const result = await tools.security_audit({}, dir);
  assert.match(result, /eval-exec-sink/);
  assert.match(result, /app\.js:2/);
});

test('security_audit detects SQL built via string concatenation', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'db.js'), 'const q = "SELECT * FROM users WHERE id = " + userId;\n');
  const result = await tools.security_audit({}, dir);
  assert.match(result, /sql-injection/);
});

test('security_audit detects weak crypto (MD5) and JWT "none" algorithm misconfiguration', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'auth.js'), [
    "const hash = crypto.createHash('md5').update(password).digest('hex');",
    "const opts = { algorithms: ['none'] };",
    '',
  ].join('\n'));
  const result = await tools.security_audit({}, dir);
  assert.match(result, /weak-crypto/);
  assert.match(result, /jwt-misconfig/);
});

test('security_audit skips node_modules and other noise directories', async () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'const password = "abcdefghijklmnopqrstuvwx";\n');
  // A real top-level file too, so the scan has something to actually report on —
  // otherwise (node_modules being the only thing on disk) it'd correctly hit the
  // separate "no auditable files found" early-return instead of exercising the
  // "scanned N files, found nothing" path this test is actually about.
  fs.writeFileSync(path.join(dir, 'app.js'), 'function add(a, b) { return a + b; }\n');
  const result = await tools.security_audit({}, dir);
  assert.match(result, /no pattern-matched issues found/);
});

test('security_audit can be scoped to a specific subdirectory or file via the path param', async () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'other'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const password = "abcdefghijklmnopqrstuvwx";\n');
  fs.writeFileSync(path.join(dir, 'other', 'b.js'), 'const password = "zzzzzzzzzzzzzzzzzzzzzzzz";\n');

  const scoped = await tools.security_audit({ path: 'other' }, dir);
  assert.match(scoped, /b\.js/);
  assert.doesNotMatch(scoped, /a\.js/);
});

test('security_audit sorts findings with HIGH severity before MEDIUM/LOW', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'mixed.js'), [
    "const hash = crypto.createHash('md5').update(x).digest('hex'); // MEDIUM",
    "eval(x); // HIGH",
    '',
  ].join('\n'));
  const result = await tools.security_audit({}, dir);
  const highIndex = result.indexOf('[HIGH]');
  const mediumIndex = result.indexOf('[MEDIUM]');
  assert.ok(highIndex >= 0 && mediumIndex >= 0, 'expected both severities to be present');
  assert.ok(highIndex < mediumIndex, 'expected HIGH findings to be listed before MEDIUM ones');
});

test('security_audit truncates past 60 findings and saves the full report to .kode/scans/', async () => {
  const dir = makeTempDir();
  // 70 separate files, each with one HIGH eval() finding — cheap way to force >60
  // total findings without relying on any single regex matching many times per line.
  for (let i = 0; i < 70; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.js`), `eval(input${i});\n`);
  }
  const result = await tools.security_audit({}, dir);
  assert.match(result, /found 70 candidate/);
  assert.match(result, /more finding\(s\) not shown/);
  assert.match(result, /saved to \.kode\/scans\//);

  const scanFiles = fs.readdirSync(path.join(dir, '.kode', 'scans'));
  assert.equal(scanFiles.length, 1);
});

test('run_command blocks catastrophic patterns without executing them', async () => {
  const destructive = ['rm -rf /', 'rm -rf ~', 'sudo rm -rf /Users', ':(){ :|:& };:', 'mkfs.ext4 /dev/sda1'];
  for (const command of destructive) {
    const result = await tools.run_command({ command });
    assert.match(result, /🚫 Blocked/, `expected "${command}" to be blocked`);
  }
});

test('run_command allows an ordinary command through and returns its output', async () => {
  const result = await tools.run_command({ command: 'echo hello-from-kode-test' });
  assert.match(result, /hello-from-kode-test/);
});

test('run_command surfaces a risk note for risky-but-legitimate patterns without blocking them', async () => {
  // Decodes an empty base64 payload into bash — harmless to actually run, but matches
  // the "pipe into a shell" shape we warn about instead of hard-blocking.
  const result = await tools.run_command({ command: 'echo "" | base64 -d | bash' });
  assert.match(result, /⚠️ Risk note/);
});

test('run_command blocks a risky-but-allowed command when confirmRiskyCommand declines it', async () => {
  let calledWith = null;
  const toolContext = {
    confirmRiskyCommand: async (command, label) => {
      calledWith = { command, label };
      return false; // user clicked "Block"
    },
  };
  const command = 'echo "" | base64 -d | bash';
  const result = await tools.run_command({ command }, null, toolContext);

  assert.match(result, /🚫 Blocked.*user declined/i);
  assert.ok(calledWith, 'expected confirmRiskyCommand to have been called');
  assert.equal(calledWith.command, command);
  assert.match(calledWith.label, /base64/i);
});

test('run_command executes a risky-but-allowed command when confirmRiskyCommand approves it', async () => {
  const toolContext = { confirmRiskyCommand: async () => true };
  // Same shape as the existing "surfaces a risk note" test, but this time routed
  // through an approving confirmation callback — should still run and still carry
  // the risk note, just without being blocked.
  const result = await tools.run_command({ command: 'echo "" | base64 -d | bash' }, null, toolContext);
  assert.match(result, /⚠️ Risk note/);
  assert.doesNotMatch(result, /🚫 Blocked/);
});

test('run_command skips confirmation entirely when no confirmRiskyCommand callback is provided (safety toggle off / default call shape)', async () => {
  // Matches every other tool call site and the existing "surfaces a risk note"
  // test above — no toolContext arg at all should behave exactly as before.
  const result = await tools.run_command({ command: 'echo "" | base64 -d | bash' });
  assert.match(result, /⚠️ Risk note/);
});

test('run_command does not ask for confirmation on ordinary (non-risky) commands even when a callback is provided', async () => {
  let called = false;
  const toolContext = { confirmRiskyCommand: async () => { called = true; return false; } };
  const result = await tools.run_command({ command: 'echo hello-from-kode-test' }, null, toolContext);
  assert.match(result, /hello-from-kode-test/);
  assert.equal(called, false, 'confirmRiskyCommand should only be consulted for the risky-but-allowed tier');
});

test('run_command fails safe (blocks) if confirmRiskyCommand throws', async () => {
  const toolContext = { confirmRiskyCommand: async () => { throw new Error('renderer window closed'); } };
  const result = await tools.run_command({ command: 'echo "" | base64 -d | bash' }, null, toolContext);
  assert.match(result, /🚫 Blocked/);
});

test('run_command rejects a missing command parameter', async () => {
  const result = await tools.run_command({});
  assert.match(result, /command.*required/i);
});

// ─── Auto-saving truncated output to .kode/scans/ ────────────────────────────

test('run_command saves the full output to .kode/scans/ when it gets truncated, and says so', async () => {
  const dir = makeTempDir();
  // Print more than the 5KB truncation cap.
  const result = await tools.run_command({ command: `node -e "for (let i = 0; i < 2000; i++) console.log('line ' + i)"` }, dir);

  assert.match(result, /output truncated/);
  assert.match(result, /📁 Full output .* saved to \.kode\/scans\//);

  const scansDir = path.join(dir, '.kode', 'scans');
  const files = fs.readdirSync(scansDir);
  assert.equal(files.length, 1);
  const saved = fs.readFileSync(path.join(scansDir, files[0]), 'utf-8');
  assert.match(saved, /line 0/);
  assert.match(saved, /line 1999/); // the part that got cut from the returned result
});

test('run_command does not save anything when output is short enough to fit untruncated', async () => {
  const dir = makeTempDir();
  const result = await tools.run_command({ command: 'echo short output' }, dir);
  assert.doesNotMatch(result, /Full output/);
  assert.ok(!fs.existsSync(path.join(dir, '.kode', 'scans')));
});

test('run_command does not crash saving output when no project folder is active', async () => {
  const result = await tools.run_command({ command: `node -e "for (let i = 0; i < 2000; i++) console.log('line ' + i)"` });
  assert.match(result, /output truncated/);
  assert.doesNotMatch(result, /Full output/); // nowhere to save it — silently skipped
});

test('run_command registers detected server commands with processManager and keeps capturing their output', async (t) => {
  // Regression test for the gap where a detached server's stdout/stderr were torn
  // down and lost after the 3s startup check — this asserts the process shows up
  // in processManager (so the UI's Processes panel can see it) and that output
  // printed after startup keeps landing in its log buffer instead of vanishing.
  const processManager = require('../src/agent/processManager');

  // Matches the isServerCommand `/node\s+.*server/i` pattern; keeps running past the
  // 3s startup-detection window instead of exiting immediately.
  const command = 'node -e "console.log(\'mock server listening on port 4321\'); setInterval(() => {}, 1000)"';
  const result = await tools.run_command({ command });

  assert.match(result, /✅ Server started/);
  assert.match(result, /Processes panel/);

  const pidMatch = result.match(/PID:\s*(\d+)/);
  assert.ok(pidMatch, 'expected the result to report a PID');
  const pid = parseInt(pidMatch[1], 10);

  t.after(() => processManager.stop(pid)); // avoid leaking a live node process after the test run

  const tracked = processManager.list().find((p) => p.pid === pid);
  assert.ok(tracked, 'expected the server to be registered in processManager');
  assert.equal(tracked.status, 'running');
  assert.match(processManager.getLog(pid), /mock server listening on port 4321/);
});

test('firecrawl_scrape fails clearly without an API key configured', async () => {
  const original = process.env.FIRECRAWL_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  try {
    const result = await tools.firecrawl_scrape({ url: 'https://example.com' });
    assert.match(result, /FIRECRAWL_API_KEY/);
  } finally {
    if (original !== undefined) process.env.FIRECRAWL_API_KEY = original;
  }
});

test('TOOL_SCHEMAS covers every tool name returned by the module', () => {
  const schemaNames = tools.TOOL_SCHEMAS.map(s => s.function.name).sort();
  const toolNames = Object.keys(tools).filter(k => typeof tools[k] === 'function').sort();
  assert.deepEqual(schemaNames, toolNames);
});

test('isReadOnlyToolCall classifies pure-read tools as read-only', () => {
  for (const name of ['read_file', 'list_directory', 'search_files', 'git_status', 'git_diff', 'web_search', 'firecrawl_scrape', 'recall_memory', 'semantic_search']) {
    assert.equal(tools.isReadOnlyToolCall(name, {}), true, `expected ${name} to be read-only`);
  }
});

test('isReadOnlyToolCall classifies side-effecting tools as not read-only', () => {
  for (const name of ['create_file', 'edit_file', 'apply_patch', 'run_command', 'run_tests', 'git_checkpoint', 'git_revert', 'write_plan', 'save_memory', 'index_codebase']) {
    assert.equal(tools.isReadOnlyToolCall(name, {}), false, `expected ${name} to NOT be read-only`);
  }
});

test('isReadOnlyToolCall treats http_request as read-only only for GET/HEAD (default GET)', () => {
  assert.equal(tools.isReadOnlyToolCall('http_request', {}), true, 'no method specified defaults to GET');
  assert.equal(tools.isReadOnlyToolCall('http_request', { method: 'GET' }), true);
  assert.equal(tools.isReadOnlyToolCall('http_request', { method: 'get' }), true, 'method check should be case-insensitive');
  assert.equal(tools.isReadOnlyToolCall('http_request', { method: 'HEAD' }), true);
  assert.equal(tools.isReadOnlyToolCall('http_request', { method: 'POST' }), false);
  assert.equal(tools.isReadOnlyToolCall('http_request', { method: 'PUT' }), false);
  assert.equal(tools.isReadOnlyToolCall('http_request', { method: 'DELETE' }), false);
});

test('READ_ONLY_TOOLS and isReadOnlyToolCall are not enumerable on the tools dispatch map', () => {
  // Guards against repeating the exact bug this pattern was written to avoid (see
  // quickSyntaxCheck's non-enumerable export just above it in tools.js): if either of
  // these were ever accidentally exported as a plain enumerable property, the
  // "TOOL_SCHEMAS covers every tool name" test above would start failing since
  // isReadOnlyToolCall is a function and would look like an unschema'd 21st tool.
  const toolNames = Object.keys(tools).filter(k => typeof tools[k] === 'function');
  assert.ok(!toolNames.includes('isReadOnlyToolCall'));
  assert.ok(!Object.keys(tools).includes('READ_ONLY_TOOLS'));
});

test('save_memory requires an active project folder', async () => {
  const result = await tools.save_memory({ key: 'a', value: 'b' }, null);
  assert.match(result, /requires an active project folder/);
});

test('save_memory and recall_memory round-trip through the project memory store', async () => {
  const dir = makeTempDir();
  const saveResult = await tools.save_memory({ key: 'dev-port', value: 'App runs on port 5001', tags: ['flask'] }, dir);
  assert.match(saveResult, /🧠 Saved/);

  const recallResult = await tools.recall_memory({ query: 'what port' }, dir);
  assert.match(recallResult, /dev-port/);
  assert.match(recallResult, /5001/);
});

test('recall_memory reports clearly when nothing matches', async () => {
  const dir = makeTempDir();
  const result = await tools.recall_memory({ query: 'nonexistent-topic' }, dir);
  assert.match(result, /No saved memory matched/);
});

test('save_memory computes and stores an embedding vector when an embedding client is available', async () => {
  const dir = makeTempDir();
  const fakeClient = { embed: async () => [[1, 0, 0]] };
  await tools.save_memory({ key: 'dev-port', value: 'App runs on port 5001', tags: ['flask'] }, dir, { embedClient: fakeClient });

  const memory = require('../src/agent/memory');
  const entries = memory.loadMemory(dir).entries;
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].vector, [1, 0, 0]);
});

test('save_memory still succeeds (without a vector) when the embedding call itself fails', async () => {
  const dir = makeTempDir();
  const brokenClient = { embed: async () => { throw new Error('ollama unreachable'); } };
  const result = await tools.save_memory({ key: 'dev-port', value: 'App runs on port 5001' }, dir, { embedClient: brokenClient });
  assert.match(result, /🧠 Saved/);

  const memory = require('../src/agent/memory');
  const entries = memory.loadMemory(dir).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].vector, null);
});

test('save_memory does not touch embeddings at all when no embedding client is in toolContext', async () => {
  const dir = makeTempDir();
  const result = await tools.save_memory({ key: 'dev-port', value: 'App runs on port 5001' }, dir);
  assert.match(result, /🧠 Saved/);
  const memory = require('../src/agent/memory');
  assert.equal(memory.loadMemory(dir).entries[0].vector, null);
});

test('recall_memory uses semantic search (and says so) when an embedding client and vectorized entries are available', async () => {
  const dir = makeTempDir();
  // Two entries whose embedding vectors clearly cluster apart, same setup style as
  // the index_codebase/semantic_search fake-client test above.
  const fakeClient = {
    embed: async (model, input) => {
      const texts = Array.isArray(input) ? input : [input];
      return texts.map((t) => {
        const lower = t.toLowerCase();
        return lower.includes('port') || lower.includes('5001') ? [1, 0, 0] : [0, 1, 0];
      });
    },
  };
  await tools.save_memory({ key: 'dev-port', value: 'App runs on port 5001' }, dir, { embedClient: fakeClient });
  await tools.save_memory({ key: 'db-choice', value: 'Using SQLite locally' }, dir, { embedClient: fakeClient });

  const result = await tools.recall_memory({ query: 'what port does the server use' }, dir, { embedClient: fakeClient });
  assert.match(result, /semantic match/);
  assert.match(result, /dev-port/);
});

test('recall_memory falls back to keyword search when no embedding client is provided at recall time', async () => {
  const dir = makeTempDir();
  const fakeClient = { embed: async () => [[1, 0, 0]] };
  // Saved WITH a vector...
  await tools.save_memory({ key: 'dev-port', value: 'App runs on port 5001' }, dir, { embedClient: fakeClient });
  // ...but recalled WITHOUT an embedding client — should still work via keyword
  // overlap, not silently fail just because a vector happens to be on disk.
  const result = await tools.recall_memory({ query: 'port' }, dir);
  assert.doesNotMatch(result, /semantic match/);
  assert.match(result, /dev-port/);
});

test('web_search fails clearly without an API key configured', async () => {
  const original = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  try {
    const result = await tools.web_search({ query: 'test query' });
    assert.match(result, /BRAVE_SEARCH_API_KEY/);
  } finally {
    if (original !== undefined) process.env.BRAVE_SEARCH_API_KEY = original;
  }
});

test('web_search requires a query parameter', async () => {
  const result = await tools.web_search({});
  assert.match(result, /query.*required/i);
});

// ─── Git safety-net tools ────────────────────────────────────────────────────

test('git_status reports clearly when the folder is not a git repo yet', async () => {
  const dir = makeTempDir();
  const result = await tools.git_status({}, dir);
  assert.match(result, /not \(inside\) a git repository/i);
});

test('git_checkpoint auto-initializes a repo and commits everything', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');

  const result = await tools.git_checkpoint({ message: 'first save' }, dir);
  assert.match(result, /Initialized a new git repository/i);
  assert.match(result, /Checkpoint created/);
  assert.match(result, /first save/);

  // A second checkpoint with no new changes should say there's nothing to do.
  const second = await tools.git_checkpoint({ message: 'again' }, dir);
  assert.match(second, /Nothing to checkpoint/);
});

test('git_status and git_diff reflect changes after a checkpoint', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  await tools.git_checkpoint({ message: 'init' }, dir);

  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello world');
  const status = await tools.git_status({}, dir);
  assert.match(status, /a\.txt/);

  const diff = await tools.git_diff({}, dir);
  assert.match(diff, /hello world/);
});

test('git_diff saves the full diff to .kode/scans/ when it gets truncated', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  await tools.git_checkpoint({ message: 'init' }, dir);

  // Enough changed lines to comfortably exceed git_diff's 6KB truncation cap.
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), big);

  const diff = await tools.git_diff({}, dir);
  assert.match(diff, /diff truncated/);
  assert.match(diff, /📁 Full output .* saved to \.kode\/scans\//);
  assert.ok(fs.readdirSync(path.join(dir, '.kode', 'scans')).length === 1);
});

test('git_revert with no params discards uncommitted changes back to the last checkpoint', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  await tools.git_checkpoint({ message: 'init' }, dir);

  fs.writeFileSync(path.join(dir, 'a.txt'), 'oops, broke it');
  const result = await tools.git_revert({}, dir);
  assert.match(result, /Discarded all uncommitted changes/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8'), 'hello');
});

test('git_revert with a file reverts just that file', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'world');
  await tools.git_checkpoint({ message: 'init' }, dir);

  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed a');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'changed b');
  const result = await tools.git_revert({ file: 'a.txt' }, dir);
  assert.match(result, /Reverted "a\.txt"/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8'), 'hello');
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf-8'), 'changed b');
});

test('git_diff and git_revert report clearly when there is no git repo yet', async () => {
  const dir = makeTempDir();
  assert.match(await tools.git_diff({}, dir), /not \(inside\) a git repository/i);
  assert.match(await tools.git_revert({}, dir), /not \(inside\) a git repository/i);
});

// ─── apply_patch ─────────────────────────────────────────────────────────────

test('apply_patch creates a new file from a /dev/null diff', async () => {
  const dir = makeTempDir();
  const patch = [
    '--- /dev/null',
    '+++ b/hello.py',
    '@@ -0,0 +1,2 @@',
    '+print("hi")',
    '+print("bye")',
    '',
  ].join('\n');

  const result = await tools.apply_patch({ patch }, dir);
  assert.match(result, /✅ Created hello\.py/);
  assert.equal(fs.readFileSync(path.join(dir, 'hello.py'), 'utf-8'), 'print("hi")\nprint("bye")');
});

test('apply_patch modifies an existing file via a single hunk', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2\nline3\n');

  const patch = [
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,3 @@',
    ' line1',
    '-line2',
    '+line2-changed',
    ' line3',
    '',
  ].join('\n');

  const result = await tools.apply_patch({ patch }, dir);
  assert.match(result, /✅ Patched a\.txt/);
  // The original file has a trailing newline — applying the patch should preserve it.
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8'), 'line1\nline2-changed\nline3\n');
});

test('apply_patch falls back to content-based matching when the hunk line numbers are wrong', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\ny\nz\nline2\nq\n');

  // Hunk claims line2 is at line 1, but it's actually at line 4 — a common local-model mistake.
  const patch = [
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,1 +1,1 @@',
    '-line2',
    '+line2-changed',
    '',
  ].join('\n');

  const result = await tools.apply_patch({ patch }, dir);
  assert.match(result, /✅ Patched a\.txt/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8'), 'x\ny\nz\nline2-changed\nq\n');
});

test('apply_patch reports a clear per-file error when a hunk cannot be located at all', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'completely different content\n');

  const patch = [
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,1 +1,1 @@',
    '-this text does not exist in the file',
    '+replacement',
    '',
  ].join('\n');

  const result = await tools.apply_patch({ patch }, dir);
  assert.match(result, /❌ Failed to patch a\.txt/);
  assert.match(result, /did not match the file's current content/);
});

test('apply_patch requires a patch parameter', async () => {
  const result = await tools.apply_patch({}, '/tmp');
  assert.match(result, /"patch".*required/i);
});

// ─── run_tests ───────────────────────────────────────────────────────────────

test('run_tests reports success for a passing command', async () => {
  const dir = makeTempDir();
  const result = await tools.run_tests({ command: 'echo all-tests-passed' }, dir);
  assert.match(result, /✅ Tests passed/);
  assert.match(result, /all-tests-passed/);
});

test('run_tests reports failure with output for a failing command', async () => {
  const dir = makeTempDir();
  const result = await tools.run_tests({ command: 'echo boom 1>&2; exit 1' }, dir);
  assert.match(result, /❌ Tests failed/);
  assert.match(result, /boom/);
});

test('run_tests saves the full output to .kode/scans/ when it gets truncated', async () => {
  const dir = makeTempDir();
  const command = `node -e "for (let i = 0; i < 3000; i++) console.log('line ' + i)"`;
  const result = await tools.run_tests({ command }, dir);
  assert.match(result, /output truncated/);
  assert.match(result, /📁 Full output .* saved to \.kode\/scans\//);
  assert.ok(fs.readdirSync(path.join(dir, '.kode', 'scans')).length === 1);
});

// ─── write_plan ──────────────────────────────────────────────────────────────

test('write_plan formats a checklist and counts completed steps', async () => {
  const result = await tools.write_plan({
    steps: [
      { text: 'Read the file', status: 'done' },
      { text: 'Fix the bug', status: 'in_progress' },
      { text: 'Run tests' },
    ],
  });
  assert.match(result, /1\/3 done/);
  assert.match(result, /\[x\] Read the file/);
  assert.match(result, /\[~\] Fix the bug/);
  assert.match(result, /\[ \] Run tests/);
});

test('write_plan requires a non-empty steps array', async () => {
  assert.match(await tools.write_plan({}), /"steps".*required/i);
  assert.match(await tools.write_plan({ steps: [] }), /"steps".*required/i);
});

test('write_plan persists an incomplete plan to .kode/plan.json', async () => {
  const dir = makeTempDir();
  await tools.write_plan({
    steps: [
      { text: 'Read the file', status: 'done' },
      { text: 'Fix the bug', status: 'pending' },
    ],
  }, dir);

  const planPath = path.join(dir, '.kode', 'plan.json');
  assert.ok(fs.existsSync(planPath), 'expected .kode/plan.json to be written');
  const saved = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
  assert.equal(saved.steps.length, 2);
  assert.equal(saved.steps[0].status, 'done');
  assert.ok(typeof saved.updatedAt === 'number');
});

test('write_plan clears the persisted plan once every step is done', async () => {
  const dir = makeTempDir();
  await tools.write_plan({ steps: [{ text: 'Step 1', status: 'pending' }] }, dir);
  const planPath = path.join(dir, '.kode', 'plan.json');
  assert.ok(fs.existsSync(planPath), 'expected the plan to exist while incomplete');

  await tools.write_plan({ steps: [{ text: 'Step 1', status: 'done' }] }, dir);
  assert.ok(!fs.existsSync(planPath), 'expected the plan file to be removed once complete');
});

test('write_plan does not touch disk when no project folder is active', async () => {
  // Should behave exactly as it did before persistence was added — no projectFolder,
  // no crash, just the formatted checklist.
  const result = await tools.write_plan({ steps: [{ text: 'Step 1', status: 'pending' }] });
  assert.match(result, /0\/1 done/);
});

// ─── Semantic search (index_codebase / semantic_search) ─────────────────────

test('index_codebase and semantic_search fail clearly without an embedding-capable client', async () => {
  const dir = makeTempDir();
  assert.match(await tools.index_codebase({}, dir, {}), /requires the Ollama provider/);
  assert.match(await tools.semantic_search({ query: 'auth logic' }, dir, {}), /requires the Ollama provider/);
});

test('semantic_search requires a query parameter', async () => {
  const dir = makeTempDir();
  const fakeClient = { embed: async () => [[1, 0, 0]] };
  const result = await tools.semantic_search({}, dir, { ollamaClient: fakeClient });
  assert.match(result, /"query".*required/i);
});

test('index_codebase and semantic_search round-trip against a fake embedding client', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'auth.js'), 'function login(user, pass) { return checkPassword(user, pass); }');
  fs.writeFileSync(path.join(dir, 'math.js'), 'function add(a, b) { return a + b; }');

  // A tiny fake embedding client: turns text into a crude 2-d vector so files about
  // "login"/"password" cluster away from files about "add"/"math" — enough to prove
  // the index→search round trip and cosine ranking work, without needing real Ollama.
  const fakeClient = {
    embed: async (model, input) => {
      const texts = Array.isArray(input) ? input : [input];
      return texts.map((t) => {
        const lower = t.toLowerCase();
        const authScore = (lower.match(/login|password|auth/g) || []).length;
        const mathScore = (lower.match(/add|math|sum/g) || []).length;
        return [authScore, mathScore];
      });
    },
  };

  const indexResult = await tools.index_codebase({}, dir, { ollamaClient: fakeClient });
  assert.match(indexResult, /✅ Indexed 2 files/);

  const searchResult = await tools.semantic_search({ query: 'password' }, dir, { ollamaClient: fakeClient });
  assert.match(searchResult, /auth\.js/);
});
