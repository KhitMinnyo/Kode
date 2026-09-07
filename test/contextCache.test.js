'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const contextCache = require('../src/agent/contextCache');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kode-contextcache-test-'));
}

test('getEntry returns null when nothing has been cached yet', () => {
  const dir = makeTempDir();
  assert.equal(contextCache.getEntry(dir, 'model-a::hello'), null);
});

test('getEntry returns null (not a throw) for a missing/null project folder or fingerprint', () => {
  assert.equal(contextCache.getEntry(null, 'model-a::hello'), null);
  assert.equal(contextCache.getEntry(makeTempDir(), null), null);
});

test('setEntry persists an entry to .kode/context-cache.json and getEntry reads it back', () => {
  const dir = makeTempDir();
  const ok = contextCache.setEntry(dir, 'model-a::hello', { droppedCount: 5, summary: 'the user asked for X, files Y/Z were edited', scratchNote: '' });
  assert.equal(ok, true);
  assert.ok(fs.existsSync(contextCache.cacheFilePath(dir)));

  const entry = contextCache.getEntry(dir, 'model-a::hello');
  assert.ok(entry, 'expected the entry to round-trip');
  assert.equal(entry.droppedCount, 5);
  assert.equal(entry.summary, 'the user asked for X, files Y/Z were edited');
  assert.ok(typeof entry.updatedAt === 'number', 'expected setEntry to stamp updatedAt');
});

test('setEntry overwrites an existing fingerprint rather than duplicating it', () => {
  const dir = makeTempDir();
  contextCache.setEntry(dir, 'model-a::hello', { droppedCount: 5, summary: 'first summary' });
  contextCache.setEntry(dir, 'model-a::hello', { droppedCount: 9, summary: 'updated summary' });

  const cache = contextCache.loadCache(dir);
  assert.equal(Object.keys(cache).length, 1);
  assert.equal(cache['model-a::hello'].summary, 'updated summary');
  assert.equal(cache['model-a::hello'].droppedCount, 9);
});

test('setEntry keeps separate fingerprints (different models/conversations) independent', () => {
  const dir = makeTempDir();
  contextCache.setEntry(dir, 'model-a::conversation-1', { droppedCount: 3, summary: 'summary one' });
  contextCache.setEntry(dir, 'model-b::conversation-2', { droppedCount: 7, summary: 'summary two' });

  assert.equal(contextCache.getEntry(dir, 'model-a::conversation-1').summary, 'summary one');
  assert.equal(contextCache.getEntry(dir, 'model-b::conversation-2').summary, 'summary two');
});

test('setEntry rotates out the oldest-updated entries once past MAX_ENTRIES (50)', () => {
  const dir = makeTempDir();
  // Write 55 entries with strictly increasing updatedAt so the first 5 written are
  // unambiguously the oldest. setEntry stamps updatedAt = Date.now() itself, so we
  // can't control it directly — but each write happens strictly after the previous
  // one in wall-clock terms, and rotation sorts by updatedAt, so this is deterministic
  // regardless of how fast the loop runs (ties would only occur with identical
  // millisecond timestamps, which loadCache/setEntry's full read-modify-write per call
  // makes vanishingly unlikely for a plain synchronous loop).
  for (let i = 0; i < 55; i++) {
    contextCache.setEntry(dir, `model-a::conversation-${i}`, { droppedCount: i, summary: `summary ${i}` });
  }

  const cache = contextCache.loadCache(dir);
  const keys = Object.keys(cache);
  assert.equal(keys.length, 50, 'expected rotation to cap the cache at MAX_ENTRIES');
  // The oldest 5 (conversation-0..4) should have been evicted.
  for (let i = 0; i < 5; i++) {
    assert.equal(cache[`model-a::conversation-${i}`], undefined, `expected conversation-${i} to be evicted`);
  }
  // The most recent ones should still be present.
  assert.ok(cache['model-a::conversation-54'], 'expected the most recently written entry to survive');
});

test('loadCache fails soft (empty object) on a corrupt cache file instead of throwing', () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, '.kode'), { recursive: true });
  fs.writeFileSync(contextCache.cacheFilePath(dir), 'not valid json{{{', 'utf-8');
  assert.deepEqual(contextCache.loadCache(dir), {});
});

test('loadCache fails soft when the cache file holds a JSON array instead of an object', () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, '.kode'), { recursive: true });
  fs.writeFileSync(contextCache.cacheFilePath(dir), '["not", "an", "object"]', 'utf-8');
  assert.deepEqual(contextCache.loadCache(dir), {});
});
