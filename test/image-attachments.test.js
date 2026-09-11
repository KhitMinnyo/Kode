'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  textOf,
  imagePartsOf,
  buildContent,
  withText,
  toPlainText,
  IMAGE_TOKEN_ESTIMATE,
} = require('../src/shared/messageContent');

const AgentCore = require('../src/agent/core');
const { estimateMessageTokens } = AgentCore._testUtils;

const CustomClient = require('../src/custom/client');
const OpenAIClient = require('../src/openai/client');
const DeepSeekClient = require('../src/deepseek/client');
const AnthropicClient = require('../src/anthropic/client');
const OllamaClient = require('../src/ollama/client');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg==';
const image = (name = 'shot.png') => ({ data: PNG_B64, mediaType: 'image/png', name });

/** Captures the exact request body a client would put on the wire. */
function captureRequest(client) {
  const captured = {};
  client._streamRequest = async (method, path, body) => {
    captured.body = body;
  };
  client._streamRequestWithRetry = client._streamRequest;
  return captured;
}

// ───────────────── the neutral content shape ─────────────────

test('buildContent leaves a text-only message as a plain string', () => {
  // The shape only changes when there is actually an image — a text turn must stay
  // byte-for-byte what it was before images existed.
  assert.equal(buildContent('hello', []), 'hello');
  assert.equal(buildContent('hello', undefined), 'hello');
  assert.equal(buildContent('hello', [{ mediaType: 'image/png' }]), 'hello', 'an image with no data is not an image');
});

test('buildContent produces text + image parts, and the helpers read them back', () => {
  const content = buildContent('what is this dialog?', [image('Screenshot.png')]);
  assert.ok(Array.isArray(content));
  assert.equal(textOf(content), 'what is this dialog?');
  assert.equal(imagePartsOf(content).length, 1);
  assert.equal(imagePartsOf(content)[0].data, PNG_B64);
  assert.match(toPlainText(content), /what is this dialog\?\n\[image: Screenshot\.png\]/);
});

test('withText trims the text while keeping the images intact', () => {
  // Context trimming must never slice an image — half a base64 blob is worthless and
  // would corrupt the request.
  const content = buildContent('a very long question', [image()]);
  const trimmed = withText(content, 'a very');
  assert.equal(textOf(trimmed), 'a very');
  assert.equal(imagePartsOf(trimmed).length, 1);
  assert.equal(imagePartsOf(trimmed)[0].data, PNG_B64);
});

test('estimateMessageTokens charges for images instead of ignoring them', () => {
  const text = 'look at this';
  const withImage = buildContent(text, [image(), image('b.png')]);
  assert.equal(
    estimateMessageTokens(withImage),
    estimateMessageTokens(text) + 2 * IMAGE_TOKEN_ESTIMATE,
    'two images must cost two image allowances on top of the text',
  );
});

// ───────────────── per-provider wire shapes ─────────────────

test('OpenAI-compatible clients send images as image_url data URLs', async () => {
  for (const client of [new CustomClient('k', 'http://127.0.0.1:1/v1'), new OpenAIClient('k'), new DeepSeekClient('k')]) {
    const captured = captureRequest(client);
    await client.chat('m', [{ role: 'user', content: buildContent('what is this?', [image()]) }]);

    const content = captured.body.messages[0].content;
    assert.deepEqual(content[0], { type: 'text', text: 'what is this?' });
    assert.equal(content[1].type, 'image_url');
    assert.equal(content[1].image_url.url, `data:image/png;base64,${PNG_B64}`);
  }
});

test('OpenAI-compatible clients leave a text-only message exactly as it was', async () => {
  const client = new CustomClient('k', 'http://127.0.0.1:1/v1');
  const captured = captureRequest(client);
  await client.chat('m', [{ role: 'user', content: 'plain text' }]);
  assert.equal(captured.body.messages[0].content, 'plain text');
});

test('AnthropicClient sends images as base64 source blocks, not data URLs', async () => {
  const client = new AnthropicClient('k');
  const captured = captureRequest(client);
  await client.chat('claude-test', [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: buildContent('what is this?', [image()]) },
  ]);

  assert.equal(captured.body.system, 'be helpful');
  const content = captured.body.messages[0].content;
  assert.deepEqual(content[0], { type: 'text', text: 'what is this?' });
  assert.deepEqual(content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PNG_B64 },
  });
});

test('OllamaClient puts the text on content and the images in a message-level array', async () => {
  const client = new OllamaClient();
  const captured = captureRequest(client);
  await client.chat('llava', [{ role: 'user', content: buildContent('what is this?', [image()]) }], () => {}, { contextSize: 4096 });

  const msg = captured.body.messages[0];
  assert.equal(msg.content, 'what is this?', 'Ollama takes plain text, not content parts');
  assert.deepEqual(msg.images, [PNG_B64]);
});

// ───────────────── AgentCore threading ─────────────────

test('processMessage turns attached images into multimodal content for the model', async () => {
  let sentMessages = null;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async (model, messages) => {
      sentMessages = messages;
      return { text: '✅ Done: that is a Windows installer warning.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  await core.processMessage(
    'what is this?', 'test-model', [], () => {}, () => {}, null, () => {}, null, null,
    [image('Screenshot.png')],
  );

  const userMsg = sentMessages.filter(m => m.role === 'user').pop();
  assert.ok(Array.isArray(userMsg.content), 'the user turn must carry image content');
  assert.equal(textOf(userMsg.content), 'what is this?');
  assert.equal(imagePartsOf(userMsg.content)[0].name, 'Screenshot.png');
});

test('processMessage keeps a text-only turn as a plain string', async () => {
  let sentMessages = null;
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    chat: async (model, messages) => {
      sentMessages = messages;
      return { text: '✅ Done.', toolCalls: [] };
    },
  };

  const core = new AgentCore(mockClient, 8192, 'ollama');
  await core.processMessage('just text', 'test-model', [], () => {}, () => {}, null, () => {});

  const userMsg = sentMessages.filter(m => m.role === 'user').pop();
  assert.equal(typeof userMsg.content, 'string');
});

test('context trimming survives multimodal content instead of slicing it apart', async () => {
  // The trimming path used to assume content was a string (content.slice(0, n)); on an
  // array that silently produces a sliced ARRAY, i.e. a corrupted message.
  const mockClient = {
    getContextSize: async () => 8192,
    abort() {},
    // Trimming history triggers the rolling-summary path, which asks the model to
    // summarise what was dropped.
    chat: async () => ({ text: 'Earlier: the user asked about a screenshot.', toolCalls: [] }),
  };
  const core = new AgentCore(mockClient, 8192, 'ollama');

  const longText = 'x'.repeat(20000);
  const history = [{ role: 'user', content: buildContent(longText, [image()]) }];
  const messages = await core._buildContextMessages(
    { role: 'system', content: 'sys' }, history, 2048, 'test-model', null,
  );

  const userMsg = messages.filter(m => m.role === 'user').pop();
  assert.ok(Array.isArray(userMsg.content), 'content must still be multimodal after trimming');
  assert.equal(imagePartsOf(userMsg.content).length, 1, 'the image must survive the trim whole');
  assert.ok(textOf(userMsg.content).length < longText.length, 'the text must actually have been trimmed');
  assert.match(textOf(userMsg.content), /\(truncated\)$/);
});
