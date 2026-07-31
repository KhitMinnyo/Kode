'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memory = require('../src/agent/memory');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kode-memory-test-'));
}

test('loadMemory returns an empty structure when nothing has been saved', () => {
  const dir = makeTempDir();
  assert.deepEqual(memory.loadMemory(dir), { entries: [] });
});

test('loadMemory returns empty (not a throw) for a missing/null project folder', () => {
  assert.deepEqual(memory.loadMemory(null), { entries: [] });
});

test('upsertMemoryEntry creates a new entry and persists it to disk', () => {
  const dir = makeTempDir();
  const entry = memory.upsertMemoryEntry(dir, 'dev-port', 'App runs on 5001', ['flask']);
  assert.equal(entry.key, 'dev-port');
  assert.ok(fs.existsSync(memory.memoryFilePath(dir)));
  assert.equal(memory.loadMemory(dir).entries.length, 1);
});

test('upsertMemoryEntry updates an existing entry case-insensitively instead of duplicating it', () => {
  const dir = makeTempDir();
  memory.upsertMemoryEntry(dir, 'dev-port', 'App runs on 5001', []);
  memory.upsertMemoryEntry(dir, 'Dev-Port', 'Now runs on 5002', ['updated']);

  const all = memory.loadMemory(dir);
  assert.equal(all.entries.length, 1, 'same key (case-insensitive) should update, not duplicate');
  assert.equal(all.entries[0].value, 'Now runs on 5002');
  assert.deepEqual(all.entries[0].tags, ['updated']);
});

test('upsertMemoryEntry rejects a missing key or non-string value', () => {
  const dir = makeTempDir();
  assert.throws(() => memory.upsertMemoryEntry(dir, '', 'value'));
  assert.throws(() => memory.upsertMemoryEntry(dir, 'key', undefined));
});

test('upsertMemoryEntry truncates very long values instead of storing them unbounded', () => {
  const dir = makeTempDir();
  const huge = 'x'.repeat(10000);
  const entry = memory.upsertMemoryEntry(dir, 'big', huge, []);
  assert.ok(entry.value.length < huge.length);
  assert.match(entry.value, /truncated/);
});

test('searchMemory finds entries by keyword overlap in key/value/tags', () => {
  const dir = makeTempDir();
  memory.upsertMemoryEntry(dir, 'dev-port', 'The Flask dev server listens on port 5001', ['flask', 'server']);
  memory.upsertMemoryEntry(dir, 'db-choice', 'Using SQLite locally, Postgres in production', ['database']);

  const results = memory.searchMemory(dir, 'what port does the server use', 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].key, 'dev-port');
});

test('searchMemory with an empty query returns the most recently updated entries', async () => {
  const dir = makeTempDir();
  memory.upsertMemoryEntry(dir, 'first', 'first value', []);
  // Guarantee a distinct updatedAt timestamp — Date.now() has ~1ms resolution, and
  // without this the two upserts can tie, making "most recent" ambiguous by design
  // (a stable sort then just preserves insertion order).
  await new Promise((resolve) => setTimeout(resolve, 5));
  memory.upsertMemoryEntry(dir, 'second', 'second value', []);

  const results = memory.searchMemory(dir, '', 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].key, 'second', 'most recently updated should come first');
});

test('searchMemory returns nothing for a query that matches no entry', () => {
  const dir = makeTempDir();
  memory.upsertMemoryEntry(dir, 'dev-port', 'Flask on port 5001', []);
  assert.deepEqual(memory.searchMemory(dir, 'completely unrelated topic xyz', 5), []);
});

test('deleteMemoryEntry removes a matching entry and reports success/failure', () => {
  const dir = makeTempDir();
  memory.upsertMemoryEntry(dir, 'temp-note', 'delete me', []);
  assert.equal(memory.deleteMemoryEntry(dir, 'temp-note'), true);
  assert.equal(memory.loadMemory(dir).entries.length, 0);
  assert.equal(memory.deleteMemoryEntry(dir, 'does-not-exist'), false);
});

test('formatMemoryEntries produces a readable block including tags', () => {
  const entries = [{ key: 'a', value: 'b', tags: ['x', 'y'] }];
  assert.equal(memory.formatMemoryEntries(entries), '- [a]: b (tags: x, y)');
  assert.equal(memory.formatMemoryEntries([]), '');
});
