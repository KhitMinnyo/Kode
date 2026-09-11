'use strict';

/**
 * Provider-neutral multimodal message content.
 *
 * A message's `content` is normally a plain string, and stays one for every
 * text-only turn. When the user attaches images — pasting a screenshot into the
 * chat box, dropping a PNG on it — the content becomes an array of parts instead:
 *
 *   [ { type: 'text',  text: 'why does this dialog appear?' },
 *     { type: 'image', mediaType: 'image/png', data: '<base64>', name: 'Screenshot.png' } ]
 *
 * Every provider wants images in its own shape: OpenAI-compatible APIs want an
 * `image_url` part holding a data: URL, Anthropic wants an `image` block with a
 * base64 `source`, Ollama wants a message-level `images` array of bare base64
 * strings. Rather than teach AgentCore which provider it is talking to, it builds
 * this neutral shape and each client converts it on the way out (see the
 * `_normalizeMessages` method in each client).
 *
 * The helpers here exist because the rest of the app can no longer assume
 * `msg.content` is a string: token estimation, context trimming and history
 * handling all have to read the text out of a message without caring which of the
 * two shapes it happens to be in.
 */

/**
 * What one image is assumed to cost in the model's context window.
 *
 * Real cost varies enormously by provider and image size (a small thumbnail is
 * ~85 tokens on OpenAI's vision models; a full-resolution screenshot tiled at high
 * detail runs well over 1500), and Kode deliberately doesn't ship a per-provider
 * tokenizer — see estimateTokens in agent/core.js for that reasoning. This is a
 * single deliberately-generous flat estimate: over-counting costs a little context
 * headroom, while under-counting would let _buildContextMessages overflow the
 * budget it thinks it is respecting, which is the failure that actually hurts.
 */
const IMAGE_TOKEN_ESTIMATE = 800;

/** True when `content` uses the multimodal array shape rather than a plain string. */
function isMultimodal(content) {
  return Array.isArray(content);
}

/** The text of a message, whichever shape its content is in ('' when there is none). */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/** Just the image parts of a message's content (empty for plain-string content). */
function imagePartsOf(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part && part.type === 'image' && typeof part.data === 'string' && part.data);
}

/**
 * Builds message content from text plus zero or more images. Returns the plain
 * string when there are no images, so a text-only turn is byte-for-byte what it
 * always was — nothing downstream sees a new shape it didn't ask for.
 *
 * @param {string} text
 * @param {Array<{data: string, mediaType?: string, name?: string}>} [images]
 */
function buildContent(text, images) {
  const usable = Array.isArray(images)
    ? images.filter((img) => img && typeof img.data === 'string' && img.data)
    : [];
  if (usable.length === 0) return text;

  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const img of usable) {
    parts.push({
      type: 'image',
      mediaType: img.mediaType || 'image/png',
      data: img.data,
      name: img.name || null,
    });
  }
  return parts;
}

/** Same content with its text replaced — used when trimming a message to fit a budget. */
function withText(content, newText) {
  if (!Array.isArray(content)) return newText;
  const images = imagePartsOf(content);
  return buildContent(newText, images);
}

/**
 * A text-only rendering of content, for the places that must have a string: the
 * on-disk rolling context summary, conversation fingerprints, scan-output detection.
 * Images become a short marker rather than being dropped silently, so a summary of a
 * trimmed conversation still records that a screenshot was part of it.
 */
function toPlainText(content) {
  if (typeof content === 'string') return content;
  const text = textOf(content);
  const images = imagePartsOf(content);
  if (images.length === 0) return text;
  const markers = images.map((img) => `[image: ${img.name || img.mediaType || 'attached image'}]`).join(' ');
  return text ? `${text}\n${markers}` : markers;
}

module.exports = {
  IMAGE_TOKEN_ESTIMATE,
  isMultimodal,
  textOf,
  imagePartsOf,
  buildContent,
  withText,
  toPlainText,
};
