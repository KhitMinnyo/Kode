'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getSystemPrompt, getAvailableToolNames, supportsNativeToolCalling } = require('../src/agent/prompts');

test('getAvailableToolNames includes every implemented tool', () => {
  const names = getAvailableToolNames();
  for (const expected of ['create_file', 'edit_file', 'read_file', 'run_command', 'list_directory', 'http_request', 'search_files', 'firecrawl_scrape']) {
    assert.ok(names.includes(expected), `expected ${expected} to be listed as available`);
  }
});

test('supportsNativeToolCalling recognizes known tool-calling-capable families', () => {
  for (const model of ['llama3.1:8b', 'llama3.2:3b', 'qwen2.5-coder:7b', 'qwen3.6:27b', 'mistral-nemo:12b', 'command-r:35b']) {
    assert.equal(supportsNativeToolCalling(model), true, `${model} should be treated as native-tool-calling capable`);
  }
});

test('supportsNativeToolCalling rejects models known to only follow the markdown convention', () => {
  for (const model of ['deepseek-r1:8b', 'DeepHat/DeepHat-V1-7B', 'dolphin3:8b']) {
    assert.equal(supportsNativeToolCalling(model), false, `${model} should NOT be treated as native-tool-calling capable`);
  }
});

test('supportsNativeToolCalling is case-insensitive and tolerates missing input', () => {
  assert.equal(supportsNativeToolCalling('QWEN2.5:7B'), true);
  assert.equal(supportsNativeToolCalling(), false);
});

test('getSystemPrompt includes the project folder when provided', () => {
  const prompt = getSystemPrompt('/Users/test/my-project', 'llama3.1:8b');
  assert.match(prompt, /\/Users\/test\/my-project/);
});

test('getSystemPrompt switches to the full red-team prompt for uncensored models', () => {
  const standard = getSystemPrompt(null, 'llama3.1:8b');
  const uncensored = getSystemPrompt(null, 'dolphin3:8b');
  assert.doesNotMatch(standard, /Red Team Operator Mode/);
  assert.match(uncensored, /Red Team Operator Mode/);
});
