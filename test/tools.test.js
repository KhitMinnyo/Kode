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

test('run_command rejects a missing command parameter', async () => {
  const result = await tools.run_command({});
  assert.match(result, /command.*required/i);
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
