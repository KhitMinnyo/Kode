'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_DIR_NAME = '.kode';
const CACHE_FILE_NAME = 'context-cache.json';
const MAX_ENTRIES = 50; // rotation cap — oldest-updated entries get dropped past this

/**
 * Persists AgentCore's rolling context-summary cache (_contextSummaryCache in
 * core.js) to <project>/.kode/context-cache.json. Without this, a summary generated
 * once (an LLM call, up to a 20s timeout — see _summarizeDroppedHistory) had to be
 * regenerated from scratch every time the app restarted or a tab's AgentCore
 * instance was recreated mid-conversation, even though conversationHistory itself
 * (reconstructed by the renderer on every IPC call) was unchanged and would trim to
 * the exact same dropped boundary again.
 *
 * Purely a performance/continuity cache, not a source of truth: conversationHistory
 * is what actually drives what gets summarized. Losing this file (or it going stale/
 * corrupt) just means the next drop recomputes its summary instead of reusing one —
 * never a correctness problem, so every function here fails soft (empty/null/false)
 * rather than throwing.
 */

function cacheFilePath(projectFolder) {
  return path.join(projectFolder, CACHE_DIR_NAME, CACHE_FILE_NAME);
}

function loadCache(projectFolder) {
  if (!projectFolder) return {};
  try {
    const filePath = cacheFilePath(projectFolder);
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.warn('[ContextCache] Failed to load context cache, starting fresh:', err.message);
    return {};
  }
}

/** Reads one fingerprint's cached entry, or null if there isn't one (or none on disk). */
function getEntry(projectFolder, fingerprint) {
  if (!projectFolder || !fingerprint) return null;
  const cache = loadCache(projectFolder);
  return cache[fingerprint] || null;
}

/**
 * Writes/updates one fingerprint's entry, enforcing MAX_ENTRIES via LRU eviction
 * (same rotation approach as memory.js's upsertMemoryEntry) so a project accumulating
 * many separate chats over time doesn't grow this file unboundedly.
 */
function setEntry(projectFolder, fingerprint, entry) {
  if (!projectFolder || !fingerprint) return false;
  try {
    const cache = loadCache(projectFolder);
    cache[fingerprint] = { ...entry, updatedAt: Date.now() };

    const keys = Object.keys(cache);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => (cache[a].updatedAt || 0) - (cache[b].updatedAt || 0));
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[k];
    }

    const dir = path.join(projectFolder, CACHE_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFilePath(projectFolder), JSON.stringify(cache, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.warn('[ContextCache] Failed to save context cache:', err.message);
    return false;
  }
}

module.exports = { cacheFilePath, loadCache, getEntry, setEntry };
