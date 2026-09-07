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

test('upsertMemoryEntry stores an optional embedding vector and round-trips it to disk', () => {
  const dir = makeTempDir();
  const entry = memory.upsertMemoryEntry(dir, 'dev-port', 'App runs on 5001', [], [0.1, 0.2, 0.3]);
  assert.deepEqual(entry.vector, [0.1, 0.2, 0.3]);
  assert.deepEqual(memory.loadMemory(dir).entries[0].vector, [0.1, 0.2, 0.3]);
});

test('upsertMemoryEntry clears a stale vector when an update omits a new one', () => {
  const dir = makeTempDir();
  memory.upsertMemoryEntry(dir, 'dev-port', 'App runs on 5001', [], [0.1, 0.2, 0.3]);
  // Value changed, but this save didn't (or couldn't) compute a fresh vector — the
  // old one no longer represents the new text and should be dropped, not kept stale.
  const updated = memory.upsertMemoryEntry(dir, 'dev-port', 'App now runs on 5002', []);
  assert.equal(updated.vector, null);
});

test('compactMemory merges near-duplicate entries (by cosine similarity) into one, newer wins', () => {
  const older = { key: 'port-note-1', value: 'App runs on port 5001', tags: ['flask'], createdAt: 1000, updatedAt: 1000, vector: [1, 0, 0] };
  const newer = { key: 'port-note-2', value: 'The dev server listens on 5001', tags: ['server'], createdAt: 2000, updatedAt: 2000, vector: [1, 0, 0.001] };
  const { entries, mergedCount } = memory.compactMemory([older, newer], 0.93);

  assert.equal(mergedCount, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, 'port-note-2', 'the newer entry should be the one that survives');
  assert.match(entries[0].value, /also: App runs on port 5001/);
  assert.deepEqual(entries[0].tags.sort(), ['flask', 'server']);
});

test('compactMemory leaves distinct (dissimilar) entries alone', () => {
  const a = { key: 'dev-port', value: 'App runs on port 5001', tags: [], createdAt: 1000, updatedAt: 1000, vector: [1, 0, 0] };
  const b = { key: 'db-choice', value: 'Using SQLite locally', tags: [], createdAt: 2000, updatedAt: 2000, vector: [0, 1, 0] };
  const { entries, mergedCount } = memory.compactMemory([a, b], 0.93);
  assert.equal(mergedCount, 0);
  assert.equal(entries.length, 2);
});

test('compactMemory never merges entries that have no stored vector', () => {
  const a = { key: 'note-a', value: 'first note', tags: [], createdAt: 1000, updatedAt: 1000, vector: null };
  const b = { key: 'note-b', value: 'second note', tags: [], createdAt: 2000, updatedAt: 2000, vector: null };
  const { entries, mergedCount } = memory.compactMemory([a, b], 0.93);
  assert.equal(mergedCount, 0);
  assert.equal(entries.length, 2);
});

test('compactMemory does not mutate its input array or entry objects', () => {
  const a = { key: 'a', value: 'v1', tags: ['t1'], createdAt: 1000, updatedAt: 1000, vector: [1, 0, 0] };
  const b = { key: 'b', value: 'v2', tags: ['t2'], createdAt: 2000, updatedAt: 2000, vector: [1, 0, 0] };
  const input = [a, b];
  memory.compactMemory(input, 0.93);
  assert.equal(input.length, 2, 'input array should be untouched');
  assert.equal(a.value, 'v1', 'original entry object should be untouched');
  assert.deepEqual(a.tags, ['t1']);
});

test('upsertMemoryEntry auto-compacts near-duplicate entries once past COMPACT_THRESHOLD (100)', () => {
  const dir = makeTempDir();
  // 101 entries sharing the exact same vector — every one after the first is a
  // near-duplicate of it. Crossing the 100-entry threshold on the 101st save should
  // trigger compactMemory internally and collapse them all down to a single entry.
  for (let i = 0; i < 101; i++) {
    memory.upsertMemoryEntry(dir, `mem-${i}`, `fact number ${i}`, [], [1, 0, 0]);
  }
  const final = memory.loadMemory(dir).entries;
  assert.equal(final.length, 1, 'expected auto-compaction to collapse 101 identical-vector entries into 1');
  assert.match(final[0].value, /also:/, 'expected the surviving entry to show evidence of a merge');
});

test('semanticSearchMemory returns nothing without an embedding-capable client', async () => {
  const dir = makeTempDir();
  memory.upsertMemoryEntry(dir, 'dev-port', 'App runs on 5001', [], [1, 0, 0]);
  assert.deepEqual(await memory.semanticSearchMemory(dir, null, 'what port'), []);
  assert.deepEqual(await memory.semanticSearchMemory(dir, {}, 'what port'), []);
});

test('semanticSearchMemory returns nothing when no saved entries have a vector yet', async () => {
  const dir = makeTempDir();
  memory.upsertMemoryEntry(dir, 'dev-port', 'App runs on 5001', []); // no vector
  const fakeClient = { embed: async () => [[1, 0, 0]] };
  assert.deepEqual(await memory.semanticSearchMemory(dir, fakeClient, 'what port'), []);
});

test('semanticSearchMemory ranks entries by cosine similarity to the embedded query', async () => {
  const dir = makeTempDir();
  memory.upsertMemoryEntry(dir, 'dev-port', 'App runs on port 5001', [], [1, 0, 0]);
  memory.upsertMemoryEntry(dir, 'db-choice', 'Using SQLite locally', [], [0, 1, 0]);
  const fakeClient = { embed: async () => [[1, 0, 0.01]] }; // closest to dev-port's vector
  const results = await memory.semanticSearchMemory(dir, fakeClient, 'what port does the app use?', 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].key, 'dev-port', 'the closer vector should rank first');
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
