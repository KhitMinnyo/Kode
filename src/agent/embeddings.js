'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Local semantic codebase search. search_files (tools.js) is grep — exact substring
 * matches only. That's fine for "where is this literal string" but useless for "where
 * is the authentication logic handled", which is exactly the kind of question an agent
 * needs to answer before it can act on a request it wasn't given exact keywords for.
 *
 * This builds a small local vector index using Ollama's embedding models (e.g.
 * `nomic-embed-text`, ~270MB, runs comfortably on CPU) — no cloud API, no extra
 * service, just a JSON file at <project>/.kode/embeddings.json. Good enough for a
 * single project's worth of code; not meant to compete with a real vector database at
 * scale, but for the file counts a local dev project actually has, brute-force cosine
 * similarity over a few thousand chunks is fast enough to feel instant.
 */

const INDEX_DIR_NAME = '.kode';
const INDEX_FILE_NAME = 'embeddings.json';
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

const CHUNK_SIZE = 1500;    // characters per chunk — rough proxy for ~400 tokens
const CHUNK_OVERLAP = 200;  // keeps a boundary-spanning definition from being split with no shared context
const MAX_FILES = 500;      // hard cap so indexing a huge/misconfigured project can't run forever
const MAX_FILE_SIZE = 200 * 1024; // skip generated/data files that would dominate the index with noise
const EMBED_BATCH_SIZE = 16;

const INDEXABLE_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift', '.rb', '.php', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.toml', '.html', '.css', '.scss', '.sh', '.sql',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.kode', 'dist', 'build', 'out', '__pycache__',
  'venv', '.venv', 'vendor', 'target', '.next', '.cache', 'coverage',
]);

function indexFilePath(projectFolder) {
  return path.join(projectFolder, INDEX_DIR_NAME, INDEX_FILE_NAME);
}

/** Recursively lists indexable files under root, relative paths, capped at MAX_FILES. */
function walkFiles(root, dir = root, out = []) {
  if (out.length >= MAX_FILES) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (!(entry.isDirectory() && entry.name === '.kode')) continue; // skip dotfiles except handled dirs above
    }
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(root, full, out);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!INDEXABLE_EXT.has(ext)) continue;

    try {
      const stat = fs.statSync(full);
      if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue;
    } catch {
      continue;
    }

    out.push(path.relative(root, full));
  }

  return out;
}

/** Splits text into overlapping chunks so a match can point at a small, readable window. */
function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (!text) return [];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
  }
  return chunks;
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Builds (or fully rebuilds) the embedding index for a project. `embedClient` is
 * anything exposing `embed(model, textOrArray) => Promise<number[][]>` — in practice
 * the app's OllamaClient instance. Embeds in small batches so one huge project doesn't
 * send one enormous request.
 * @returns {Promise<{model, builtAt, fileCount, chunkCount}>}
 */
async function buildIndex(projectFolder, embedClient, model = DEFAULT_EMBED_MODEL, onProgress = () => {}) {
  const files = walkFiles(projectFolder);
  const pending = [];

  for (const relPath of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(projectFolder, relPath), 'utf-8');
    } catch {
      continue; // binary or unreadable — skip rather than fail the whole index
    }
    chunkText(content).forEach((text, chunkIndex) => pending.push({ file: relPath, chunkIndex, text }));
  }

  const records = [];
  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedClient.embed(model, batch.map(b => b.text));
    batch.forEach((b, j) => {
      records.push({
        file: b.file,
        chunkIndex: b.chunkIndex,
        preview: b.text.length > 300 ? b.text.slice(0, 300) + '…' : b.text,
        vector: vectors[j],
      });
    });
    onProgress(Math.min(i + EMBED_BATCH_SIZE, pending.length), pending.length);
  }

  const index = {
    model,
    builtAt: Date.now(),
    fileCount: files.length,
    chunkCount: records.length,
    truncated: files.length >= MAX_FILES,
    records,
  };

  fs.mkdirSync(path.dirname(indexFilePath(projectFolder)), { recursive: true });
  fs.writeFileSync(indexFilePath(projectFolder), JSON.stringify(index), 'utf-8');

  return { model: index.model, builtAt: index.builtAt, fileCount: index.fileCount, chunkCount: index.chunkCount, truncated: index.truncated };
}

/** Loads the saved index, or null if none has been built yet / it's unreadable. */
function loadIndex(projectFolder) {
  try {
    const raw = fs.readFileSync(indexFilePath(projectFolder), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.records) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Embeds `query` and returns the top-N most similar chunks by cosine similarity.
 * @returns {Promise<Array<{file, chunkIndex, preview, score}>|null>} - null if no index exists yet.
 */
async function search(projectFolder, embedClient, query, opts = {}) {
  const index = loadIndex(projectFolder);
  if (!index) return null;

  const model = opts.model || index.model || DEFAULT_EMBED_MODEL;
  const [queryVector] = await embedClient.embed(model, [query]);

  const scored = index.records.map((r) => ({
    file: r.file,
    chunkIndex: r.chunkIndex,
    preview: r.preview,
    score: cosineSimilarity(queryVector, r.vector),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit || 8);
}

module.exports = {
  buildIndex,
  loadIndex,
  search,
  indexFilePath,
  chunkText,
  cosineSimilarity,
  walkFiles,
  DEFAULT_EMBED_MODEL,
};
