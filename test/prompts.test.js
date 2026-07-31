'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getSystemPrompt, getAvailableToolNames, supportsNativeToolCalling, looksSecurityRelated } = require('../src/agent/prompts');

test('getAvailableToolNames includes every implemented tool', () => {
  const names = getAvailableToolNames();
  for (const expected of ['create_file', 'edit_file', 'read_file', 'run_command', 'list_directory', 'http_request', 'search_files', 'firecrawl_scrape', 'web_search', 'save_memory', 'recall_memory']) {
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

test('supportsNativeToolCalling always returns true for cloud providers regardless of model name', () => {
  for (const provider of ['openai', 'anthropic', 'deepseek']) {
    assert.equal(supportsNativeToolCalling('literally-any-model-name', provider), true, `${provider} should always support native tool calling`);
    assert.equal(supportsNativeToolCalling('', provider), true, `${provider} should support it even with no model name given`);
  }
});

test('supportsNativeToolCalling falls back to the Ollama model-family allowlist when provider is ollama or omitted', () => {
  assert.equal(supportsNativeToolCalling('llama3.1:8b', 'ollama'), true);
  assert.equal(supportsNativeToolCalling('deepseek-r1:8b', 'ollama'), false);
  assert.equal(supportsNativeToolCalling('llama3.1:8b'), true, 'provider should default to ollama');
});

test('getSystemPrompt includes the project folder when provided', () => {
  const prompt = getSystemPrompt('/Users/test/my-project', 'llama3.1:8b');
  assert.match(prompt, /\/Users\/test\/my-project/);
});

test('getSystemPrompt switches to the full red-team prompt for uncensored models regardless of message', () => {
  const standard = getSystemPrompt(null, 'llama3.1:8b');
  const uncensored = getSystemPrompt(null, 'dolphin3:8b');
  assert.doesNotMatch(standard, /Red Team Operator Mode/);
  assert.match(uncensored, /Red Team Operator Mode/);
});

test('looksSecurityRelated flags obvious pentest/security phrasing and ignores plain requests', () => {
  for (const msg of ['scan 192.168.1.1', 'run an nmap scan', 'find XSS vulnerabilities', 'audit this app for security issues', 'ဟက်ကာဖို့ ကြိုးစားပါ']) {
    assert.equal(looksSecurityRelated(msg), true, `"${msg}" should be flagged as security-related`);
  }
  for (const msg of ['write a python function to sort a list', 'fix this bug in app.js', 'add a login form', '']) {
    assert.equal(looksSecurityRelated(msg), false, `"${msg}" should NOT be flagged as security-related`);
  }
});

test('getSystemPrompt omits the full pentest playbook for plain coding requests on standard models', () => {
  const plain = getSystemPrompt(null, 'llama3.1:8b', 'write a function to reverse a string');
  assert.doesNotMatch(plain, /Recon methodology/);
  assert.doesNotMatch(plain, /Pentester Mindset/);
  assert.match(plain, /Security Tasks/); // still gets the short pointer
});

test('getSystemPrompt includes the standard pentest playbook when the message looks security-related', () => {
  const securityTask = getSystemPrompt(null, 'llama3.1:8b', 'scan 10.0.0.5 and find vulnerabilities');
  assert.match(securityTask, /Recon methodology/);
  assert.match(securityTask, /Pentester Mindset/);
});

test('getSystemPrompt includes the full red-team playbook for uncensored models when the message looks security-related', () => {
  const securityTask = getSystemPrompt(null, 'dolphin3:8b', 'scan 10.0.0.5 and find vulnerabilities');
  assert.match(securityTask, /Red Team Operator Mode/);
});
