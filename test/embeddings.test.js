'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const embeddings = require('../src/agent/embeddings');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kode-embed-test-'));
}

test('chunkText splits long text into overlapping chunks and returns short text as one chunk', () => {
  assert.deepEqual(embeddings.chunkText(''), []);
  assert.deepEqual(embeddings.chunkText('short'), ['short']);

  const long = 'a'.repeat(3000);
  const chunks = embeddings.chunkText(long, 1000, 100);
  assert.ok(chunks.length > 1);
  // Every chunk after the first should overlap with the tail of the previous one.
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i - 1].slice(-100), chunks[i].slice(0, 100));
  }
});

test('cosineSimilarity is 1 for identical vectors and 0 for orthogonal ones', () => {
  assert.equal(embeddings.cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(embeddings.cosineSimilarity([1, 0], [0, 1]), 0);
  assert.ok(embeddings.cosineSimilarity([1, 1], [1, 0]) > 0 && embeddings.cosineSimilarity([1, 1], [1, 0]) < 1);
});

test('cosineSimilarity handles zero vectors without dividing by zero', () => {
  assert.equal(embeddings.cosineSimilarity([0, 0], [1, 1]), 0);
});

test('walkFiles skips node_modules/.git and non-indexable extensions, respects the file cap', () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'ignored');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const a = 1;');
  fs.writeFileSync(path.join(dir, 'src', 'b.png'), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(dir, 'readme.md'), '# hi');

  const files = embeddings.walkFiles(dir);
  assert.ok(files.includes(path.join('src', 'a.js')));
  assert.ok(files.includes('readme.md'));
  assert.ok(!files.some(f => f.includes('node_modules')));
  assert.ok(!files.some(f => f.endsWith('.png')));
});

test('buildIndex + loadIndex + search round-trip using a fake embedding client', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'a.js'), 'const secret = "hello";');

  const fakeClient = { embed: async (model, input) => (Array.isArray(input) ? input : [input]).map(() => [1, 2, 3]) };

  const summary = await embeddings.buildIndex(dir, fakeClient, 'fake-model');
  assert.equal(summary.fileCount, 1);
  assert.ok(summary.chunkCount >= 1);

  const loaded = embeddings.loadIndex(dir);
  assert.ok(loaded);
  assert.equal(loaded.model, 'fake-model');

  const results = await embeddings.search(dir, fakeClient, 'anything', { limit: 5 });
  assert.ok(results.length >= 1);
  assert.equal(results[0].file, 'a.js');
});

test('loadIndex returns null when no index has been built yet', () => {
  const dir = makeTempDir();
  assert.equal(embeddings.loadIndex(dir), null);
});

test('search returns null when no index has been built yet', async () => {
  const dir = makeTempDir();
  const fakeClient = { embed: async () => [[1, 0]] };
  const result = await embeddings.search(dir, fakeClient, 'query');
  assert.equal(result, null);
});
