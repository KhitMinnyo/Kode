'use strict';

const fs = require('fs');
const path = require('path');
// Reuse the same cosine-similarity math (and default embedding model name) that
// embeddings.js already uses for codebase search, rather than reimplementing vector
// comparison a second time for memory entries.
const { cosineSimilarity, DEFAULT_EMBED_MODEL } = require('./embeddings');

const MEMORY_DIR_NAME = '.kode';
const MEMORY_FILE_NAME = 'memory.json';
const MAX_ENTRIES = 500;          // rotation cap — oldest-updated entries get dropped past this
const MAX_VALUE_LENGTH = 4000;    // per-entry cap so one save_memory call can't balloon the file
const COMPACT_THRESHOLD = 100;    // once past this many entries, try merging near-duplicates first
// Cosine similarity required to treat two entries as near-duplicates worth merging.
// Deliberately high — a false merge silently discards a distinct fact, so it's far
// better to under-merge (leave two related-but-different notes separate) than over-merge.
const MERGE_SIMILARITY_THRESHOLD = 0.93;

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
 *
 * @param {number[]|null} vector - optional embedding vector for this entry's text
 *   (key + value + tags), computed by the caller (save_memory in tools.js) when an
 *   embedding client is available. Powers semanticSearchMemory below. Omit/pass null
 *   when embeddings aren't available (e.g. cloud provider) — keyword search (see
 *   searchMemory) still works fine without it. On an UPDATE to an existing entry, an
 *   omitted vector invalidates whatever vector was stored before (the value just
 *   changed, so the old vector no longer represents it) rather than silently keeping
 *   a now-stale one; a brand new entry with no vector simply never gets one this call.
 */
function upsertMemoryEntry(projectFolder, key, value, tags = [], vector = null) {
  if (!projectFolder) return null;
  if (!key || typeof key !== 'string') throw new Error('Memory key is required');
  if (typeof value !== 'string') throw new Error('Memory value is required and must be a string');

  const memory = loadMemory(projectFolder);
  const truncatedValue = value.length > MAX_VALUE_LENGTH
    ? value.slice(0, MAX_VALUE_LENGTH) + '\n... (truncated)'
    : value;
  const normalizedTags = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
  const normalizedVector = Array.isArray(vector) ? vector : null;
  const now = Date.now();

  const existingIndex = memory.entries.findIndex((e) => e.key.toLowerCase() === key.toLowerCase());
  let entry;
  if (existingIndex >= 0) {
    entry = memory.entries[existingIndex];
    entry.value = truncatedValue;
    entry.tags = normalizedTags;
    entry.updatedAt = now;
    entry.vector = normalizedVector; // null clears a now-stale vector when none was supplied
  } else {
    entry = { key, value: truncatedValue, tags: normalizedTags, createdAt: now, updatedAt: now, vector: normalizedVector };
    memory.entries.push(entry);
  }

  // Auto-compact: once past COMPACT_THRESHOLD, try merging near-duplicate (by
  // embedding similarity) entries before falling back to hard MAX_ENTRIES rotation.
  // Runs against whatever's in memory right now, including the entry just
  // upserted — since it always has the newest updatedAt, compactMemory's
  // oldest-first processing guarantees it survives any merge intact (see its doc
  // comment), so re-finding it by key below is always safe.
  if (memory.entries.length > COMPACT_THRESHOLD) {
    const { entries: compacted, mergedCount } = compactMemory(memory.entries);
    if (mergedCount > 0) {
      memory.entries = compacted;
      console.log(`[Memory] Auto-compacted ${mergedCount} near-duplicate entr${mergedCount === 1 ? 'y' : 'ies'}.`);
    }
  }

  // Rotation: keep only the MAX_ENTRIES most recently updated entries.
  if (memory.entries.length > MAX_ENTRIES) {
    memory.entries.sort((a, b) => b.updatedAt - a.updatedAt);
    memory.entries = memory.entries.slice(0, MAX_ENTRIES);
  }

  saveMemory(projectFolder, memory);
  // Compaction may have replaced `entry`'s object identity (compactMemory returns
  // shallow copies, never mutates in place) — re-find it by key rather than
  // returning the possibly-stale local reference.
  return memory.entries.find((e) => e.key.toLowerCase() === key.toLowerCase()) || entry;
}

/**
 * Merges near-duplicate entries (by embedding cosine similarity) into one, so a
 * project that accumulates many overlapping/restated facts over time ("dev port is
 * 5001", "the app runs on port 5001", "server listens on 5001") doesn't just pile
 * them all up until the hard MAX_ENTRIES rotation eventually starts silently
 * dropping the oldest ones. Deterministic, no LLM call — only entries that already
 * have a stored embedding vector (see upsertMemoryEntry's vector param) are ever
 * compared; anything without one (embeddings unavailable, or not yet computed for
 * that entry) is left untouched and always kept as-is.
 *
 * Processes oldest-first so a newer entry always "wins" a merge over an older,
 * similar one — its key, value, and vector are what survive in `kept`; the older
 * entry's tags are folded in (union) and its value appended only if it isn't
 * already substantially contained in the surviving value.
 *
 * @param {Array} entries
 * @param {number} threshold - cosine similarity required to consider two entries
 *   near-duplicates (see MERGE_SIMILARITY_THRESHOLD's doc comment for why it's high).
 * @returns {{entries: Array, mergedCount: number}} - never mutates the input array
 *   or its entry objects; `entries` in the result are fresh objects.
 */
function compactMemory(entries, threshold = MERGE_SIMILARITY_THRESHOLD) {
  const sorted = [...entries].sort((a, b) => a.updatedAt - b.updatedAt); // oldest → newest
  const kept = [];
  let mergedCount = 0;

  for (const entry of sorted) {
    let mergedIndex = -1;
    if (Array.isArray(entry.vector)) {
      for (let idx = 0; idx < kept.length; idx++) {
        if (!Array.isArray(kept[idx].vector)) continue;
        if (cosineSimilarity(entry.vector, kept[idx].vector) >= threshold) {
          mergedIndex = idx;
          break;
        }
      }
    }

    if (mergedIndex >= 0) {
      // We're processing oldest → newest, so `entry` here is newer than whatever it
      // just matched — it wins: its key/value/vector become the surviving record.
      // The older kept value is folded in as historical context (via "(also: ...)")
      // rather than discarded, and createdAt is preserved from whichever entry in
      // this cluster was seen first, so the merged record still remembers when the
      // underlying fact was originally established.
      const existing = kept[mergedIndex];
      const mergedValue = existing.value && !entry.value.includes(existing.value)
        ? `${entry.value} (also: ${existing.value})`.slice(0, MAX_VALUE_LENGTH)
        : entry.value;
      kept[mergedIndex] = {
        key: entry.key,
        value: mergedValue,
        tags: Array.from(new Set([...existing.tags, ...entry.tags])),
        createdAt: existing.createdAt,
        updatedAt: entry.updatedAt,
        vector: entry.vector,
      };
      mergedCount++;
    } else {
      kept.push({ ...entry, tags: [...entry.tags] });
    }
  }

  return { entries: kept, mergedCount };
}

/**
 * Meaning-based recall: embeds the query and ranks entries by cosine similarity
 * against each entry's stored vector (see upsertMemoryEntry's vector param, set by
 * save_memory in tools.js when an embedding client is available). Entries without a
 * stored vector are skipped here rather than scored as 0 — recall_memory (tools.js)
 * falls back to searchMemory's keyword overlap when this returns no usable results
 * (no embedding client available, or no entries have vectors yet), so nothing is
 * silently made unfindable just because it predates this feature.
 * @returns {Promise<Array>} - entries, or [] if there's nothing usable to search.
 */
async function semanticSearchMemory(projectFolder, embedClient, query, limit = 5, model) {
  if (!embedClient || typeof embedClient.embed !== 'function') return [];
  if (!query || typeof query !== 'string' || !query.trim()) return [];

  const memory = loadMemory(projectFolder);
  const vectorized = memory.entries.filter((e) => Array.isArray(e.vector));
  if (vectorized.length === 0) return [];

  const embedModel = model || DEFAULT_EMBED_MODEL;
  const [queryVector] = await embedClient.embed(embedModel, [query]);
  if (!Array.isArray(queryVector)) return [];

  return vectorized
    .map((entry) => ({ entry, score: cosineSimilarity(queryVector, entry.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry);
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
  semanticSearchMemory,
  compactMemory,
  formatMemoryEntries,
  memoryFilePath,
};
