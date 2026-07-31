'use strict';

const fs = require('fs');
const path = require('path');

const MEMORY_DIR_NAME = '.kode';
const MEMORY_FILE_NAME = 'memory.json';
const MAX_ENTRIES = 500;          // rotation cap — oldest-updated entries get dropped past this
const MAX_VALUE_LENGTH = 4000;    // per-entry cap so one save_memory call can't balloon the file

/**
 * Per-project persistent memory ("brain") for Kode's agent. Unlike the in-session
 * rolling context summary (see agent/core.js _buildContextMessages), this survives
 * app restarts and is explicitly written/read by the model via the save_memory and
 * recall_memory tools — it's for durable facts ("the API uses port 5001", "user
 * prefers Tailwind over plain CSS"), not a transcript of the conversation.
 *
 * Stored at <projectFolder>/.kode/memory.json — plain JSON, no external dependency,
 * good enough for the scale of a single project's worth of notes. Gitignored by
 * default (see .gitignore) since it's personal working data, not source code.
 */

function memoryFilePath(projectFolder) {
  return path.join(projectFolder, MEMORY_DIR_NAME, MEMORY_FILE_NAME);
}

function emptyMemory() {
  return { entries: [] };
}

/**
 * @returns {{entries: Array<{key: string, value: string, tags: string[], createdAt: number, updatedAt: number}>}}
 */
function loadMemory(projectFolder) {
  if (!projectFolder) return emptyMemory();
  try {
    const filePath = memoryFilePath(projectFolder);
    if (!fs.existsSync(filePath)) return emptyMemory();
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) return emptyMemory();
    return parsed;
  } catch (err) {
    console.warn('[Memory] Failed to load memory file, treating as empty:', err.message);
    return emptyMemory();
  }
}

function saveMemory(projectFolder, memoryData) {
  if (!projectFolder) return false;
  try {
    const dir = path.join(projectFolder, MEMORY_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(memoryFilePath(projectFolder), JSON.stringify(memoryData, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.warn('[Memory] Failed to save memory file:', err.message);
    return false;
  }
}

/**
 * Insert or update an entry by key (case-insensitive match). Enforces MAX_VALUE_LENGTH
 * per entry and MAX_ENTRIES total (dropping the least-recently-updated entries first).
 */
function upsertMemoryEntry(projectFolder, key, value, tags = []) {
  if (!projectFolder) return null;
  if (!key || typeof key !== 'string') throw new Error('Memory key is required');
  if (typeof value !== 'string') throw new Error('Memory value is required and must be a string');

  const memory = loadMemory(projectFolder);
  const truncatedValue = value.length > MAX_VALUE_LENGTH
    ? value.slice(0, MAX_VALUE_LENGTH) + '\n... (truncated)'
    : value;
  const normalizedTags = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
  const now = Date.now();

  const existingIndex = memory.entries.findIndex((e) => e.key.toLowerCase() === key.toLowerCase());
  let entry;
  if (existingIndex >= 0) {
    entry = memory.entries[existingIndex];
    entry.value = truncatedValue;
    entry.tags = normalizedTags;
    entry.updatedAt = now;
  } else {
    entry = { key, value: truncatedValue, tags: normalizedTags, createdAt: now, updatedAt: now };
    memory.entries.push(entry);
  }

  // Rotation: keep only the MAX_ENTRIES most recently updated entries.
  if (memory.entries.length > MAX_ENTRIES) {
    memory.entries.sort((a, b) => b.updatedAt - a.updatedAt);
    memory.entries = memory.entries.slice(0, MAX_ENTRIES);
  }

  saveMemory(projectFolder, memory);
  return entry;
}

function deleteMemoryEntry(projectFolder, key) {
  if (!projectFolder || !key) return false;
  const memory = loadMemory(projectFolder);
  const before = memory.entries.length;
  memory.entries = memory.entries.filter((e) => e.key.toLowerCase() !== key.toLowerCase());
  if (memory.entries.length === before) return false;
  saveMemory(projectFolder, memory);
  return true;
}

/**
 * Keyword-overlap search — no embeddings/vector DB, just scores entries by how many
 * query words appear in their key/value/tags. Good enough for a single project's
 * notes; if this stops being precise enough at scale, swap in an Ollama embedding
 * model for real semantic search without changing the storage format.
 */
function searchMemory(projectFolder, query, limit = 5) {
  const memory = loadMemory(projectFolder);
  if (memory.entries.length === 0) return [];

  if (!query || typeof query !== 'string' || !query.trim()) {
    return [...memory.entries].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  const queryWords = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (queryWords.length === 0) {
    return [...memory.entries].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  const scored = memory.entries.map((entry) => {
    const haystack = `${entry.key} ${entry.value} ${entry.tags.join(' ')}`.toLowerCase();
    const score = queryWords.reduce((s, w) => s + (haystack.includes(w) ? 1 : 0), 0);
    return { entry, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
    .slice(0, limit)
    .map((s) => s.entry);
}

/** Compact text block suitable for injecting into a prompt or returning from a tool. */
function formatMemoryEntries(entries) {
  if (!entries || entries.length === 0) return '';
  return entries.map((e) => `- [${e.key}]: ${e.value}${e.tags.length ? ` (tags: ${e.tags.join(', ')})` : ''}`).join('\n');
}

module.exports = {
  loadMemory,
  saveMemory,
  upsertMemoryEntry,
  deleteMemoryEntry,
  searchMemory,
  formatMemoryEntries,
  memoryFilePath,
};
