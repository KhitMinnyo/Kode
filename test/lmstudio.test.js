'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLmStudioUrl, LMSTUDIO_BASE_URL } = require('../src/shared/lmstudio');

test('normalizeLmStudioUrl fills in a bare LAN host:port so Kali → Mac just works', () => {
  // The whole point: a user enters their Mac's IP and LM Studio port, nothing else.
  assert.equal(normalizeLmStudioUrl('192.168.1.100:1234'), 'http://192.168.1.100:1234/v1');
  assert.equal(normalizeLmStudioUrl('localhost:1234'), 'http://localhost:1234/v1');
});

test('normalizeLmStudioUrl leaves a fully-specified URL alone', () => {
  assert.equal(normalizeLmStudioUrl('http://192.168.1.100:1234/v1'), 'http://192.168.1.100:1234/v1');
  assert.equal(normalizeLmStudioUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1');
});

test('normalizeLmStudioUrl adds /v1 when the user gave only a scheme + host:port', () => {
  assert.equal(normalizeLmStudioUrl('http://192.168.1.100:1234'), 'http://192.168.1.100:1234/v1');
});

test('normalizeLmStudioUrl does not double up a scheme, and preserves a non-default path', () => {
  assert.equal(normalizeLmStudioUrl('https://example.com:1234/v1'), 'https://example.com:1234/v1');
});

test('normalizeLmStudioUrl falls back to the local default when empty', () => {
  assert.equal(normalizeLmStudioUrl(''), LMSTUDIO_BASE_URL);
  assert.equal(normalizeLmStudioUrl(undefined), LMSTUDIO_BASE_URL);
});
