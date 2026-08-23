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
