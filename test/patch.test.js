'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseUnifiedDiff, applyHunksToContent, PatchError } = require('../src/agent/patch');

test('parseUnifiedDiff extracts a single-file, single-hunk diff', () => {
  const patch = [
    '--- a/foo.js',
    '+++ b/foo.js',
    '@@ -1,2 +1,2 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '',
  ].join('\n');

  const files = parseUnifiedDiff(patch);
  assert.equal(files.length, 1);
  assert.equal(files[0].oldPath, 'foo.js');
  assert.equal(files[0].newPath, 'foo.js');
  assert.equal(files[0].hunks.length, 1);
  assert.equal(files[0].hunks[0].oldStart, 1);
  assert.deepEqual(files[0].hunks[0].lines.map(l => l.type), [' ', '-', '+']);
});

test('parseUnifiedDiff handles multiple files in one patch', () => {
  const patch = [
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1,1 +1,1 @@',
    '-foo',
    '+bar',
    '',
  ].join('\n');

  const files = parseUnifiedDiff(patch);
  assert.equal(files.length, 2);
  assert.equal(files[0].newPath, 'a.txt');
  assert.equal(files[1].newPath, 'b.txt');
});

test('parseUnifiedDiff returns an empty array for non-diff text', () => {
  assert.deepEqual(parseUnifiedDiff('just some plain text, not a diff'), []);
});

test('applyHunksToContent applies a single hunk at the declared line', () => {
  const original = 'line1\nline2\nline3';
  const files = parseUnifiedDiff([
    '--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' line1', '-line2', '+line2X', ' line3', '',
  ].join('\n'));
  const result = applyHunksToContent(original, files[0].hunks);
  assert.equal(result, 'line1\nline2X\nline3');
});

test('applyHunksToContent applies multiple hunks in one file, adjusting for earlier insertions', () => {
  const original = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
  const patch = [
    '--- a/f', '+++ b/f',
    '@@ -1,2 +1,3 @@',
    ' a',
    '+inserted',
    ' b',
    '@@ -5,2 +6,2 @@',
    ' e',
    '-f',
    '+f-changed',
    '',
  ].join('\n');
  const files = parseUnifiedDiff(patch);
  const result = applyHunksToContent(original, files[0].hunks);
  assert.equal(result, ['a', 'inserted', 'b', 'c', 'd', 'e', 'f-changed'].join('\n'));
});

test('applyHunksToContent falls back to content search when the declared line number is wrong', () => {
  const original = ['x', 'y', 'z', 'target', 'w'].join('\n');
  // Hunk says the removed line is at line 1, but "target" is actually at line 4.
  const files = parseUnifiedDiff(['--- a/f', '+++ b/f', '@@ -1,1 +1,1 @@', '-target', '+replaced', ''].join('\n'));
  const result = applyHunksToContent(original, files[0].hunks);
  assert.equal(result, ['x', 'y', 'z', 'replaced', 'w'].join('\n'));
});

test('applyHunksToContent throws a PatchError with a clear message when a hunk cannot be located', () => {
  const original = 'totally unrelated content';
  const files = parseUnifiedDiff(['--- a/f', '+++ b/f', '@@ -1,1 +1,1 @@', '-nonexistent line', '+new line', ''].join('\n'));
  assert.throws(() => applyHunksToContent(original, files[0].hunks), PatchError);
});

test('applyHunksToContent supports a pure-insertion hunk (no removed/context lines)', () => {
  const original = '';
  const files = parseUnifiedDiff(['--- /dev/null', '+++ b/f', '@@ -0,0 +1,2 @@', '+line1', '+line2', ''].join('\n'));
  const result = applyHunksToContent(original, files[0].hunks);
  assert.equal(result, 'line1\nline2');
});
