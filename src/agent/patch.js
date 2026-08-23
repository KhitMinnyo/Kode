'use strict';

/**
 * Minimal, dependency-free unified-diff parser + applier used by tools.js's
 * apply_patch. Supports the standard `diff -u` / `git diff` format: `--- a/file`,
 * `+++ b/file` headers and `@@ -oldStart,oldLines +newStart,newLines @@` hunks.
 *
 * Why this exists instead of just using edit_file everywhere: edit_file requires the
 * model to reproduce an exact old_content string, which local models frequently get
 * subtly wrong on anything longer than a few lines (whitespace, quoting, one word off).
 * A diff only requires the model to state what changed, which is both cheaper in
 * tokens and much more often correct. To make that trade-off actually pay off with
 * local models — which also routinely get the *line numbers* in a hunk header slightly
 * wrong even when the diff content itself is right — applyHunksToContent() falls back
 * to locating a hunk by its content (context + removed lines) when the stated line
 * number doesn't match, instead of failing the whole patch.
 */

class PatchError extends Error {}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses unified-diff text into an array of per-file entries:
 *   { oldPath, newPath, hunks: [{ oldStart, oldLines, newStart, newLines, lines: [{type, text}] }] }
 * `type` is ' ' (context), '-' (removed) or '+' (added). `oldPath`/`newPath` are the
 * paths with the conventional `a/`/`b/` prefix stripped; either can be '/dev/null'.
 */
function parseUnifiedDiff(patchText) {
  const rawLines = patchText.replace(/\r\n/g, '\n').split('\n');
  const files = [];
  let current = null;
  let currentHunk = null;

  const stripPrefix = (p) => p.replace(/^[ab]\//, '');

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    if (line.startsWith('--- ')) {
      current = { oldPath: stripPrefix(line.slice(4).trim().split('\t')[0]), newPath: null, hunks: [] };
      currentHunk = null;
      continue;
    }

    if (line.startsWith('+++ ') && current) {
      current.newPath = stripPrefix(line.slice(4).trim().split('\t')[0]);
      files.push(current);
      continue;
    }

    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch && current) {
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldLines: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newLines: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
      };
      current.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue; // preamble / "diff --git" / index lines — ignore

    if (line.startsWith('\\ No newline at end of file')) continue;

    if (line.startsWith('+')) {
      currentHunk.lines.push({ type: '+', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ type: '-', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({ type: ' ', text: line.slice(1) });
    }
    // A genuinely empty context line is represented as a lone ' ' marker (handled
    // above via startsWith(' ')), never as a fully blank raw line — a blank raw line
    // only ever shows up here as the trailing artifact of the patch text's final
    // newline (every diff line, including the last, ends with \n), so it's correctly
    // ignored rather than mistaken for an empty context line. Any other line shape
    // (e.g. "diff --git", "index ...") likewise just isn't part of the hunk body.
  }

  return files.filter(f => f.newPath !== null);
}

/** The context+removed lines a hunk expects to find in the original file, in order. */
function expectedOriginalLines(hunk) {
  return hunk.lines.filter(l => l.type !== '+').map(l => l.text);
}

/**
 * Searches `origLines` for a window matching `expected`, starting the search at
 * `fromIndex` and scanning forward, then (if not found) scanning the whole file from
 * the top. Returns the 0-based index of the match, or -1.
 */
function findWindow(origLines, expected, fromIndex) {
  if (expected.length === 0) return fromIndex; // pure-insertion hunk — nothing to locate

  const tryFrom = (start) => {
    for (let i = start; i <= origLines.length - expected.length; i++) {
      let ok = true;
      for (let j = 0; j < expected.length; j++) {
        if (origLines[i + j] !== expected[j]) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  };

  const forward = tryFrom(Math.max(0, fromIndex));
  if (forward !== -1) return forward;
  return tryFrom(0);
}

/**
 * Applies a list of hunks (as produced by parseUnifiedDiff for one file) to the
 * original file content, returning the patched content. Throws PatchError with a
 * specific, actionable message if a hunk can't be located at all.
 */
function applyHunksToContent(originalContent, hunks) {
  // ''.split('\n') yields [''] (one "line"), not [] — which would make a pure-insertion
  // hunk applied to a genuinely empty file try to locate/consume a line that doesn't
  // exist. An empty file has zero lines, so treat it as such explicitly.
  const origLines = originalContent === '' ? [] : originalContent.replace(/\r\n/g, '\n').split('\n');
  const output = [];
  let cursor = 0; // 0-based index into origLines of what's already been emitted

  // Hunks in a well-formed diff are already in ascending order of oldStart.
  const ordered = [...hunks].sort((a, b) => a.oldStart - b.oldStart);

  for (const hunk of ordered) {
    const expected = expectedOriginalLines(hunk);

    // A pure-insertion hunk (no context/removed lines) doesn't need to be *located* —
    // there's nothing to match against — it just inserts at wherever we currently are.
    let matchIndex = cursor;

    if (expected.length > 0) {
      const declaredIndex = hunk.oldStart - 1;
      const declaredMatches = expected.every((line, j) => origLines[declaredIndex + j] === line);
      matchIndex = declaredIndex;

      if (!declaredMatches) {
        matchIndex = findWindow(origLines, expected, cursor);
        if (matchIndex === -1) {
          const preview = expected.slice(0, 3).join(' / ');
          throw new PatchError(
            `hunk "@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@" ` +
            `did not match the file's current content (looked for: ${preview}...). ` +
            `The file may have changed since the patch was written — read it again and regenerate the patch.`
          );
        }
      }
    }

    // Copy anything between the last hunk's end and this hunk's start verbatim.
    for (let i = cursor; i < matchIndex; i++) output.push(origLines[i]);

    // Walk the hunk body, consuming context/removed lines from the original and
    // emitting context/added lines to the output.
    let origPos = matchIndex;
    for (const l of hunk.lines) {
      if (l.type === ' ') {
        output.push(origLines[origPos] !== undefined ? origLines[origPos] : l.text);
        origPos++;
      } else if (l.type === '-') {
        origPos++; // consumed, not emitted
      } else if (l.type === '+') {
        output.push(l.text);
      }
    }

    cursor = origPos;
  }

  for (let i = cursor; i < origLines.length; i++) output.push(origLines[i]);

  return output.join('\n');
}

module.exports = { parseUnifiedDiff, applyHunksToContent, PatchError };
