'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync, spawn } = require('child_process');
const memory = require('./memory');
const plan = require('./plan');
const processManager = require('./processManager');
const { parseUnifiedDiff, applyHunksToContent, PatchError } = require('./patch');
const embeddings = require('./embeddings');

const MAX_FILE_READ_SIZE = 50 * 1024; // 50KB
const COMMAND_TIMEOUT = 30000; // 30 seconds
const EXTERNAL_FETCH_TIMEOUT = 15000; // 15 seconds — for calls to external APIs (Firecrawl, Brave Search)

// zsh is the default shell on modern macOS, but Kode also ships a Linux build
// (see package.json's `build.linux`/`build.deb` targets) where zsh usually isn't
// installed. Pick a shell that actually exists on the platform we're running on.
const DEFAULT_SHELL = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';

/**
 * fetch() has no default timeout — an unresponsive external API would otherwise hang
 * the whole agent loop indefinitely (run_command/run_tests have their own timeout via
 * runShellCommandAsync below, but the plain `fetch`-based tools didn't have an
 * equivalent). Wraps fetch with an AbortController so a slow/dead server fails fast
 * with a clear message instead.
 */
async function fetchWithTimeout(url, options = {}, timeout = EXTERNAL_FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort, fast syntax check run right after a file is written, so the agent (and
 * the user watching the tool-execution log) finds out about a broken edit immediately
 * instead of only after the next run_command/run_tests call — or not at all. Local
 * models produce syntax errors (mismatched braces, bad escaping) more often than large
 * cloud models, so catching it at write-time closes a real reliability gap.
 *
 * Deliberately narrow: only checks syntax (does it parse), never semantics, and only
 * for extensions with an ~instant, dependency-free check available. Returns null (no
 * opinion) for anything else rather than trying to be a general linter — run_tests /
 * run_command are the tools for that.
 * @returns {{ok: true}|{ok: false, error: string}|null}
 */
function quickSyntaxCheck(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  try {
    if (['.js', '.mjs', '.cjs'].includes(ext)) {
      execFileSync(process.execPath, ['--check', absPath], { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true };
    }
    if (ext === '.json') {
      JSON.parse(fs.readFileSync(absPath, 'utf-8'));
      return { ok: true };
    }
    if (ext === '.py') {
      execFileSync('python3', ['-m', 'py_compile', absPath], { timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true };
    }
    return null; // no fast checker for this extension — not an error, just no opinion
  } catch (err) {
    const raw = (err.stderr && err.stderr.toString()) || err.message || 'unknown error';
    // Keep it short — this is a heads-up appended to a tool result, not a full report.
    const trimmed = raw.trim().split('\n').slice(0, 4).join('\n');
    return { ok: false, error: trimmed };
  }
}

/** Formats a quickSyntaxCheck() result as a one-line (or few-line) suffix, or '' if there's nothing to add. */
function syntaxCheckSuffix(absPath) {
  const check = quickSyntaxCheck(absPath);
  if (!check) return '';
  if (check.ok) return '\n🔎 Syntax check: OK';
  return `\n⚠️ Syntax check found a problem — the file was still written, but likely won't run as-is:\n${check.error}`;
}

/**
 * When a tool result's output exceeds its truncation cap, saves the FULL text to
 * <project>/.kode/scans/<timestamp>-<label>.txt instead of just discarding everything
 * past the cutoff. Pentest scans especially (nmap -A, nikto, sqlmap --dump) routinely
 * produce far more than a truncation cap's worth of directly relevant detail — losing
 * everything past the first few KB with no way to recover it undermines the point of
 * running the scan in the first place. Best-effort: silently returns '' if there's no
 * project folder to save into or the write itself fails, so a save problem never turns
 * into the original tool call failing.
 * @returns {string} a note to append after the truncated text, or '' if nothing was saved.
 */
function saveFullOutput(projectFolder, label, fullText) {
  if (!projectFolder) return '';
  try {
    const dir = path.join(projectFolder, '.kode', 'scans');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(label || 'output').trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'output';
    const fileName = `${stamp}-${safeLabel}.txt`;
    fs.writeFileSync(path.join(dir, fileName), fullText, 'utf-8');
    return `\n📁 Full output (${fullText.length} bytes) saved to .kode/scans/${fileName} — use read_file with offset/limit to see the rest.`;
  } catch (err) {
    console.warn('[Tools] Failed to save full output to .kode/scans:', err.message);
    return '';
  }
}

/**
 * Tool: create_file
 * Creates a new file with the given content. Automatically creates parent directories.
 */
async function create_file(params, projectFolder) {
  const { path: filePath, content } = params;

  if (!filePath) {
    return '❌ Error: "path" parameter is required.';
  }
  if (typeof content !== 'string') {
    return '❌ Error: "content" parameter is required and must be a string.';
  }

  try {
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(projectFolder || process.cwd(), filePath);
    const dir = path.dirname(resolvedPath);

    // Create parent directories if they don't exist
    fs.mkdirSync(dir, { recursive: true });

    // Write the file
    fs.writeFileSync(resolvedPath, content, 'utf-8');

    const stats = fs.statSync(resolvedPath);
    return `✅ File created successfully: ${resolvedPath} (${stats.size} bytes)${syntaxCheckSuffix(resolvedPath)}`;
  } catch (err) {
    return `❌ Error creating file "${filePath}": ${err.message}`;
  }
}

/**
 * Tool: firecrawl_scrape
 * Extracts clean Markdown text from a URL via the Firecrawl API. Used for reading
 * documentation, CVE writeups, or JS-rendered pages that http_request can't parse well.
 * Requires a FIRECRAWL_API_KEY environment variable — without it, Firecrawl's API will
 * reject the request, so we fail fast with a clear message instead of a silent 401.
 */
async function firecrawl_scrape(params, projectFolder) {
  const url = (params && (params.url || params)) || '';

  if (!url || typeof url !== 'string') {
    return '❌ Error: "url" parameter is required.';
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return '❌ Error: firecrawl_scrape requires a FIRECRAWL_API_KEY environment variable to be set. ' +
      'Use http_request instead if you just need raw HTML/API data.';
  }

  console.log(`[+] Agent is scraping via Firecrawl: ${url}`);

  try {
    const response = await fetchWithTimeout('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
      }),
    });

    const result = await response.json();

    if (result.success && result.data && result.data.markdown) {
      const content = result.data.markdown;
      const maxLen = 5000;
      let truncated = content;
      let savedNote = '';
      if (content.length > maxLen) {
        truncated = content.substring(0, maxLen) + '\n\n... (truncated)';
        savedNote = saveFullOutput(projectFolder, 'scrape', content);
      }
      return `🌐 Scraped Content (Markdown) from ${url}:\n\n${truncated}${savedNote}`;
    }
    return `❌ Error: Failed to scrape ${url}. Firecrawl response: ${JSON.stringify(result)}`;
  } catch (error) {
    if (error.name === 'AbortError') {
      return `⏱️ Error: firecrawl_scrape timed out after ${EXTERNAL_FETCH_TIMEOUT / 1000}s fetching ${url}.`;
    }
    return `❌ Error executing firecrawl_scrape: ${error.message}`;
  }
}

/**
 * Tool: web_search
 * Searches the web via the Brave Search API. Requires a BRAVE_SEARCH_API_KEY
 * environment variable (free tier available at brave.com/search/api). This is how
 * local Ollama models — which have no built-in web access and a training cutoff —
 * can look up current information; pair it with firecrawl_scrape to read the most
 * relevant result in full, and save_memory to keep what was learned for next time.
 */
async function web_search(params) {
  const query = params && params.query;

  if (!query || typeof query !== 'string') {
    return '❌ Error: "query" parameter is required.';
  }

  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return '❌ Error: web_search requires a BRAVE_SEARCH_API_KEY environment variable to be set. ' +
      'Get a free key at https://brave.com/search/api/.';
  }

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`;
    const response = await fetchWithTimeout(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      return `❌ Error: Brave Search API returned HTTP ${response.status}: ${body.slice(0, 300)}`;
    }

    const data = await response.json();
    const results = data?.web?.results || [];

    if (results.length === 0) {
      return `🔍 No web results found for "${query}".`;
    }

    const formatted = results
      .slice(0, 8)
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description || ''}`.trim())
      .join('\n\n');

    return `🔍 Web search results for "${query}":\n\n${formatted}\n\n(Use firecrawl_scrape on a promising URL to read the full page, and save_memory to keep what you learn.)`;
  } catch (error) {
    if (error.name === 'AbortError') {
      return `⏱️ Error: web_search timed out after ${EXTERNAL_FETCH_TIMEOUT / 1000}s.`;
    }
    return `❌ Error executing web_search: ${error.message}`;
  }
}

/**
 * Tool: edit_file
 * Edits an existing file by performing a find-and-replace operation.
 */
async function edit_file(params, projectFolder) {
  const { path: filePath, old_content, new_content } = params;

  if (!filePath) {
    return '❌ Error: "path" parameter is required.';
  }
  if (typeof old_content !== 'string') {
    return '❌ Error: "old_content" parameter is required.';
  }
  if (typeof new_content !== 'string') {
    return '❌ Error: "new_content" parameter is required.';
  }

  try {
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(projectFolder || process.cwd(), filePath);

    if (!fs.existsSync(resolvedPath)) {
      return `❌ Error: File not found: ${resolvedPath}`;
    }

    const currentContent = fs.readFileSync(resolvedPath, 'utf-8');

    if (!currentContent.includes(old_content)) {
      // Provide helpful context for debugging
      const preview = currentContent.substring(0, 200);
      return `❌ Error: Could not find the specified text in "${resolvedPath}".\nFile starts with:\n${preview}...`;
    }

    // Split/join instead of String.replace(): replace() with a plain string argument
    // only touches the FIRST match, which silently disagreed with the "Replaced N
    // occurrence(s)" message below whenever old_content appeared more than once.
    const occurrences = currentContent.split(old_content).length - 1;

    const updatedContent = currentContent.split(old_content).join(new_content);
    fs.writeFileSync(resolvedPath, updatedContent, 'utf-8');

    return `✅ File edited successfully: ${resolvedPath}\n` +
           `   Replaced ${occurrences} occurrence(s) of the specified text.${syntaxCheckSuffix(resolvedPath)}`;
  } catch (err) {
    return `❌ Error editing file "${filePath}": ${err.message}`;
  }
}

/**
 * Tool: read_file
 * Reads and returns the contents of a file. Whole-file reads are capped at 50KB (see
 * MAX_FILE_READ_SIZE) — past that cap, this used to always return just the first 50KB
 * with no way to reach the rest, which made any file larger than that effectively
 * unreadable past its opening. offset/limit (1-indexed line numbers, mirroring how
 * editors and grep -A/-B report matches) let the caller target a specific window of a
 * large file instead — read the next chunk, jump to a line search_files pointed at,
 * etc — without ever loading the parts it doesn't need.
 */
async function read_file(params, projectFolder) {
  const { path: filePath, offset, limit } = params;

  if (!filePath) {
    return '❌ Error: "path" parameter is required.';
  }

  try {
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(projectFolder || process.cwd(), filePath);

    if (!fs.existsSync(resolvedPath)) {
      return `❌ Error: File not found: ${resolvedPath}`;
    }

    const stats = fs.statSync(resolvedPath);

    if (stats.isDirectory()) {
      return `❌ Error: "${resolvedPath}" is a directory, not a file. Use list_directory instead.`;
    }

    // A line range was explicitly requested — honor it regardless of file size, so a
    // specific window of even a huge file is reachable on its own terms rather than
    // always being gated behind "read (and discard) the whole 50KB-capped file first."
    if (offset !== undefined || limit !== undefined) {
      const startLine = Math.max(1, parseInt(offset, 10) || 1);
      const maxLines = Math.max(1, parseInt(limit, 10) || 2000);

      const allLines = fs.readFileSync(resolvedPath, 'utf-8').split('\n');
      const totalLines = allLines.length;
      let endLineExclusive = Math.min(totalLines, startLine - 1 + maxLines);
      const slice = allLines.slice(startLine - 1, endLineExclusive);

      if (slice.length === 0) {
        return `❌ Error: offset ${startLine} is past the end of the file (${totalLines} lines total).`;
      }

      let text = slice.map((line, i) => `${startLine + i}\t${line}`).join('\n');
      // Still respect the same overall size cap as a whole-file read, in case limit
      // was set very high on a file with unusually long lines — trims from the end
      // rather than raw-slicing the joined string, so it never cuts a line in half.
      while (Buffer.byteLength(text, 'utf-8') > MAX_FILE_READ_SIZE && slice.length > 1) {
        slice.pop();
        endLineExclusive--;
        text = slice.map((line, i) => `${startLine + i}\t${line}`).join('\n');
      }

      const more = endLineExclusive < totalLines
        ? `\n\n(${totalLines - endLineExclusive} more line(s) below — pass offset: ${endLineExclusive + 1} to continue)`
        : '';
      return `📄 ${resolvedPath} (${stats.size} bytes total, showing lines ${startLine}-${endLineExclusive} of ${totalLines}):\n\n${text}${more}`;
    }

    if (stats.size > MAX_FILE_READ_SIZE) {
      // Read only the first 50KB
      const fd = fs.openSync(resolvedPath, 'r');
      const buffer = Buffer.alloc(MAX_FILE_READ_SIZE);
      fs.readSync(fd, buffer, 0, MAX_FILE_READ_SIZE, 0);
      fs.closeSync(fd);
      const content = buffer.toString('utf-8');
      return `📄 ${resolvedPath} (${stats.size} bytes, showing first 50KB):\n\n${content}\n\n⚠️ File truncated — showing first 50KB of ${stats.size} bytes. Pass offset/limit to read a specific range of lines instead of just the start.`;
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    return `📄 ${resolvedPath} (${stats.size} bytes):\n\n${content}`;
  } catch (err) {
    return `❌ Error reading file "${filePath}": ${err.message}`;
  }
}

/**
 * Runs a shell command asynchronously (spawn) instead of with execSync.
 *
 * Why this exists: execSync blocks the ENTIRE Electron main process synchronously
 * until the command exits or its timeout fires. While that's happening, nothing else
 * in the app can run either — not the Stop button's IPC handler, not any other
 * message, nothing — so a slow or hung command (a test suite waiting on a fixture, a
 * script blocked on network I/O) froze the whole UI for the full timeout, and forever
 * if the process ignored its kill signal. This runs the command off the sync path so
 * the rest of the app keeps responding while it's in flight, and makes it genuinely
 * killable: via `signal` (wired to the Stop button, see AgentCore.stopGeneration())
 * and via its own timeout. Either kill kills the whole process group — not just the
 * top-level shell — so a piped command (`cmd | tail`) doesn't leave orphaned
 * processes still holding the pipe open after the shell itself is gone. If the
 * process ignores SIGTERM (rare, but real), it's force-killed with SIGKILL shortly
 * after so this can never hang forever.
 *
 * @returns {Promise<{stdout: string, stderr: string, code: number|null, timedOut: boolean, aborted: boolean}>}
 */
function runShellCommandAsync(command, { cwd, timeoutMs, maxBuffer = 2 * 1024 * 1024, signal } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killTimer = null;
    let hardKillTimer = null;
    let onAbort = null;

    let child;
    try {
      child = spawn(DEFAULT_SHELL, ['-c', command], {
        cwd: cwd || process.cwd(),
        detached: true, // own process group, so we can kill the whole pipeline below
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    const killGroup = (sig) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, sig); } catch { /* already dead, or never became a group leader */ }
    };

    const escalate = (reason) => {
      if (reason === 'timeout') timedOut = true;
      if (reason === 'abort') aborted = true;
      killGroup('SIGTERM');
      hardKillTimer = setTimeout(() => killGroup('SIGKILL'), 3000);
    };

    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      killTimer = setTimeout(() => escalate('timeout'), timeoutMs);
    }

    if (signal) {
      if (signal.aborted) {
        setImmediate(() => escalate('abort'));
      } else {
        onAbort = () => escalate('abort');
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };

    child.stdout.on('data', (data) => {
      if (stdout.length < maxBuffer) stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      if (stderr.length < maxBuffer) stderr += data.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, code, timedOut, aborted });
    });
  });
}

/**
 * Tool: run_command
 * Executes a shell command with a 30-second timeout and returns the output.
 *
 * @param {object} toolContext - Optional, injected by AgentCore (see agent/core.js).
 *   toolContext.confirmRiskyCommand(command, label) => boolean|Promise<boolean>, called
 *   before a "risky but allowed" pattern (see below) executes. When omitted/not a
 *   function — as in every other tool call, and in the default case where the user has
 *   turned Settings → Safety off — risky commands run exactly as before: auto-allowed
 *   with just a warning label, no confirmation step.
 *   toolContext.signal - Optional AbortSignal; aborting it kills an in-flight command
 *   immediately (wired to the Stop button — see AgentCore.stopGeneration()).
 */
async function run_command(params, projectFolder, toolContext = {}) {
  const { command } = params;

  if (!command || typeof command !== 'string') {
    return '❌ Error: "command" parameter is required.';
  }

  // Safety check: block extremely destructive commands. This is a blocklist, not a
  // sandbox — it catches known-catastrophic patterns but a local model can still
  // hallucinate other harmful commands. Since Kode can also be pointed at its own
  // source folder (self-editing), a wipe of $HOME or the app's own repo is just as
  // real a risk as wiping the system, so those are covered here too.
  const dangerous = [
    /^\s*(sudo\s+)?rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,  // rm -rf /
    /^\s*(sudo\s+)?rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/\*|~\/\*|\$HOME\/\*)$/,  // rm -rf /* or ~/* or $HOME/*
    /^\s*(sudo\s+)?rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(~|\$HOME)\s*$/,  // rm -rf ~ or $HOME (whole home dir)
    /^\s*(sudo\s+)?rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(System|Library|Applications|bin|usr|etc|var|boot)(\/|\s*$)/i,  // rm -rf on core system dirs
    /^\s*(sudo\s+)?rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/Users(\/[a-zA-Z0-9_.-]+)?\s*$/i,  // rm -rf /Users or /Users/<name>
    /mkfs\./,
    /dd\s+if=.*of=\/dev\//,
    />\s*\/dev\/(disk\d|sd[a-z]|nvme\d|rdisk\d)\b/i,  // overwriting a raw disk device via redirection
    /diskutil\s+(erasedisk|eraseVolume|reformat)/i,
    /^\s*(sudo\s+)?chmod\s+-R\s+777\s+\/\s*$/,  // chmod -R 777 /
    // Fork bomb, e.g. `:(){ :|:& };:` — the naive version of this regex (missing
    // escaped parens/braces) silently failed to match the actual fork bomb string at
    // all, since `()` was parsed as an empty capture group instead of literal
    // characters. This version matches the classic form and common whitespace variants.
    /:\s*\(\s*\)\s*\{[\s\S]*:\s*\|\s*:[\s\S]*\}\s*;\s*:/,
  ];

  for (const pattern of dangerous) {
    if (pattern.test(command)) {
      return `🚫 Blocked: This command appears to be destructive and has been blocked for safety.\nCommand: ${command}`;
    }
  }

  // Warn-but-allow tier: patterns that are legitimate in red-team/pentest workflows
  // (e.g. fetching and running a recon script on a Kali box) but are also a classic
  // remote-code-execution shape. Always labeled with a risk note in the result; when
  // Settings → Safety → "confirm risky commands" is on (the default — see
  // toolContext.confirmRiskyCommand below), execution also pauses for user approval
  // instead of running automatically.
  const riskyButAllowed = [
    { pattern: /curl[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, label: 'piping a downloaded script directly into a shell' },
    { pattern: /wget[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, label: 'piping a downloaded script directly into a shell' },
    { pattern: /base64\s+-d[^|]*\|\s*(ba)?sh\b/i, label: 'executing a base64-decoded payload' },
    { pattern: /eval\s*\(\s*(curl|wget)/i, label: 'evaluating remotely-fetched code' },
  ];
  let riskWarning = '';
  let matchedRisky = null;
  for (const entry of riskyButAllowed) {
    if (entry.pattern.test(command)) {
      matchedRisky = entry;
      riskWarning = `⚠️ Risk note: this command involves ${entry.label} — review it carefully before trusting the output.\n\n`;
      break;
    }
  }

  if (matchedRisky && typeof toolContext.confirmRiskyCommand === 'function') {
    let approved;
    try {
      approved = await toolContext.confirmRiskyCommand(command, matchedRisky.label);
    } catch (err) {
      console.warn('[run_command] confirmRiskyCommand callback threw, failing safe (deny):', err.message);
      approved = false;
    }
    if (!approved) {
      return `🚫 Blocked: user declined to approve this command (${matchedRisky.label}).\nCommand: ${command}`;
    }
  }

  // Detect server-start commands that run indefinitely
  const serverPatterns = [
    /python.*app\.py/i,
    /python.*manage\.py\s+runserver/i,
    /flask\s+run/i,
    /npm\s+(start|run\s+dev)/i,
    /node\s+.*server/i,
    /uvicorn/i,
    /gunicorn/i,
    /msfconsole/i,  // Metasploit runs interactively
  ];
  const isServerCommand = serverPatterns.some(p => p.test(command));

  // Security tools that need longer timeout
  const securityPatterns = [
    /^nmap\s/i, /^nikto\s/i, /^gobuster\s/i, /^dirb\s/i,
    /^sqlmap\s/i, /^hydra\s/i, /^ffuf\s/i, /^wfuzz\s/i,
    /^enum4linux/i, /^searchsploit/i, /^masscan/i,
    /^curl\s.*(-v|--verbose|-I|--head)/i,
  ];
  const isSecurityScan = securityPatterns.some(p => p.test(command));
  const cmdTimeout = isSecurityScan ? 120000 : 60000; // 120s for scans, 60s for regular

  try {
    if (isServerCommand) {
      // Run server as a detached background process
      try {
        const shell = DEFAULT_SHELL;
        const child = spawn(shell, ['-c', command], {
          cwd: projectFolder || process.cwd(),
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Collect early output (first 3 seconds) to detect startup errors
        let earlyStdout = '';
        let earlyStderr = '';
        child.stdout.on('data', (data) => { earlyStdout += data.toString(); });
        child.stderr.on('data', (data) => { earlyStderr += data.toString(); });

        // Wait 3 seconds to see if it crashes immediately
        const startResult = await new Promise((resolve) => {
          let exited = false;

          child.on('exit', (code) => {
            exited = true;
            if (code !== 0) {
              resolve({ ok: false, error: earlyStderr || earlyStdout || `Exit code: ${code}` });
            }
          });

          setTimeout(() => {
            if (!exited) {
              // Still running after 3s = server started successfully. Previously the
              // stdout/stderr listeners were torn down and the child fully detached
              // here, which meant any output printed after this point (request logs,
              // later crashes) was silently lost with no way to see it from the UI.
              // Instead, keep piping output into processManager's rolling log buffer
              // so a "Processes" panel can show live logs and let the user stop it.
              resolve({ ok: true, pid: child.pid });
            }
          }, 3000);
        });

        if (!startResult.ok) {
          return `❌ Server failed to start:\n$ ${command}\n${startResult.error}`;
        }

        // Try to detect port from command or early output
        const portMatch = command.match(/port[=\s]+(\d+)/i) ||
                          command.match(/:(\d{4,5})/) ||
                          earlyStdout.match(/port\s+(\d+)/i) ||
                          earlyStdout.match(/:(\d{4,5})/) ||
                          earlyStderr.match(/port\s+(\d+)/i) ||
                          earlyStderr.match(/:(\d{4,5})/);
        const port = portMatch ? portMatch[1] : '5001';

        processManager.register({
          pid: startResult.pid,
          command,
          cwd: projectFolder || process.cwd(),
          port,
          child,
        });
        // Seed the buffer with whatever was captured during the 3s startup window,
        // then keep appending as more output arrives for the life of the process.
        if (earlyStdout) processManager.appendLog(startResult.pid, earlyStdout);
        if (earlyStderr) processManager.appendLog(startResult.pid, earlyStderr);
        child.stdout.on('data', (data) => processManager.appendLog(startResult.pid, data.toString()));
        child.stderr.on('data', (data) => processManager.appendLog(startResult.pid, data.toString()));
        child.on('exit', (code) => processManager.markExited(startResult.pid, code));
        child.unref(); // Detach from Kode's own lifecycle — server survives even if Kode's main process exits

        let result = `✅ Server started (PID: ${startResult.pid}):\n$ ${command}\n🌐 Access at: http://localhost:${port}\n📋 View live logs in the Processes panel.`;
        if (earlyStdout.trim()) {
          result += `\n\nOutput:\n${earlyStdout.trim().substring(0, 500)}`;
        }
        return riskWarning + result;
      } catch (err) {
        return `❌ Failed to start server: ${err.message}`;
      }
    }

    const { stdout: rawStdout, stderr: rawStderr, code, timedOut, aborted } = await runShellCommandAsync(command, {
      cwd: projectFolder || process.cwd(),
      timeoutMs: cmdTimeout,
      maxBuffer: 2 * 1024 * 1024, // 2MB for scan outputs
      signal: toolContext.signal,
    });

    if (aborted) {
      return `🛑 Command stopped by user:\n$ ${command}` +
             (rawStdout.trim() ? `\n\nPartial output:\n${rawStdout.trim().substring(0, 2000)}` : '');
    }

    if (timedOut) {
      return `⏱️ Command timed out after ${cmdTimeout / 1000} seconds:\n$ ${command}` +
             (rawStdout.trim() ? `\n\nPartial output:\n${rawStdout.trim().substring(0, 2000)}` : '') +
             (rawStderr.trim() ? `\n\nPartial stderr:\n${rawStderr.trim().substring(0, 1000)}` : '');
    }

    if (code !== 0) {
      let result = `❌ Command failed (exit code ${code ?? 'unknown'}):\n$ ${command}`;
      if (rawStdout.trim()) result += `\n\nstdout:\n${rawStdout.trim().substring(0, 2000)}`;
      if (rawStderr.trim()) result += `\n\nstderr:\n${rawStderr.trim().substring(0, 2000)}`;
      return result;
    }

    const output = rawStdout.trim();
    if (output.length === 0) {
      return `${riskWarning}✅ Command executed successfully (no output):\n$ ${command}`;
    }
    // Truncate very long output (5KB for scan results) — but never just lose the rest
    // of it: nmap/nikto/sqlmap/etc routinely produce far more than 5KB of directly
    // relevant detail, so anything past the cutoff is saved in full to .kode/scans/
    // (see saveFullOutput) rather than discarded.
    const maxLen = 5000;
    let truncated = output;
    let savedNote = '';
    if (output.length > maxLen) {
      truncated = output.substring(0, maxLen) + '\n\n... (output truncated)';
      savedNote = saveFullOutput(projectFolder, command, output);
    }
    return `${riskWarning}✅ Command output:\n$ ${command}\n\n${truncated}${savedNote}`;
  } catch (err) {
    return `❌ Failed to run command: ${err.message}\n$ ${command}`;
  }
}

/**
 * Tool: list_directory
 * Lists the contents of a directory with file type and size information.
 */
async function list_directory(params, projectFolder) {
  const { path: dirPath } = params;

  if (!dirPath) {
    return '❌ Error: "path" parameter is required.';
  }

  try {
    const resolvedPath = path.isAbsolute(dirPath) ? dirPath : path.resolve(projectFolder || process.cwd(), dirPath);

    if (!fs.existsSync(resolvedPath)) {
      return `❌ Error: Directory not found: ${resolvedPath}`;
    }

    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
      return `❌ Error: "${resolvedPath}" is a file, not a directory. Use read_file instead.`;
    }

    const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });

    if (entries.length === 0) {
      return `📁 ${resolvedPath} (empty directory)`;
    }

    // Sort: directories first, then files, alphabetically within each group
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const lines = sorted.map((entry) => {
      const entryPath = path.join(resolvedPath, entry.name);
      try {
        if (entry.isDirectory()) {
          // Count children
          const children = fs.readdirSync(entryPath).length;
          return `  📁 ${entry.name}/ (${children} items)`;
        } else if (entry.isSymbolicLink()) {
          const target = fs.readlinkSync(entryPath);
          return `  🔗 ${entry.name} → ${target}`;
        } else {
          const fileStat = fs.statSync(entryPath);
          const size = formatFileSize(fileStat.size);
          return `  📄 ${entry.name} (${size})`;
        }
      } catch {
        return `  ❓ ${entry.name} (unable to read)`;
      }
    });

    return `📁 ${resolvedPath} (${entries.length} items):\n\n${lines.join('\n')}`;
  } catch (err) {
    return `❌ Error listing directory "${dirPath}": ${err.message}`;
  }
}

/**
 * Format bytes into human-readable size.
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
  return `${size} ${units[i]}`;
}

/**
 * Tool: http_request
 * Makes HTTP/HTTPS requests (GET, POST, etc.) for API testing, vulnerability probing.
 */
async function http_request(params, projectFolder) {
  const { url, method = 'GET', headers = {}, body = null } = params;

  if (!url) return '❌ Error: "url" parameter is required.';

  try {
    const parsedUrl = new URL(url);
    const httpModule = parsedUrl.protocol === 'https:' ? require('https') : require('http');

    return new Promise((resolve) => {
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method.toUpperCase(),
        headers: { 'User-Agent': 'Kode-Agent/1.0', ...headers },
        timeout: 15000,
      };

      const req = httpModule.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          const headerLines = Object.entries(res.headers)
            .map(([k, v]) => `  ${k}: ${v}`).join('\n');
          const preview = data.length > 3000 ? data.substring(0, 3000) + '\n...(truncated)' : data;
          resolve(`🌐 HTTP ${res.statusCode} ${res.statusMessage}\n` +
                  `URL: ${url}\nMethod: ${method}\n\nHeaders:\n${headerLines}\n\nBody (${data.length} bytes):\n${preview}`);
        });
      });

      req.on('error', (e) => resolve(`❌ Request failed: ${e.message}`));
      req.on('timeout', () => { req.destroy(); resolve('⏱️ Request timed out (15s)'); });

      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    });
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

/**
 * Tool: search_files
 * Searches for patterns in project files (grep-like).
 */
// Same directories embeddings.js's file walk already skips (see SKIP_DIRS there) —
// search_files had no such exclusion at all, so a plain grep over a project with
// node_modules present would burn most of its 50-line cap on dependency noise
// before ever reaching the user's own code.
const SEARCH_EXCLUDE_DIRS = ['node_modules', '.git', '.kode', 'dist', 'build', 'out', '__pycache__', 'venv', '.venv', 'vendor', 'target', '.next', '.cache', 'coverage'];

async function search_files(params, projectFolder) {
  const { pattern, path: searchPath = '.', file_pattern = '' } = params;

  if (!pattern) return '❌ Error: "pattern" parameter is required.';

  try {
    const resolvedPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(projectFolder || process.cwd(), searchPath);
    const excludeFlags = SEARCH_EXCLUDE_DIRS.map((d) => `--exclude-dir='${d}'`).join(' ');

    let cmd = `grep -rn ${excludeFlags} --include='*' "${pattern.replace(/"/g, '\\"')}" "${resolvedPath}" 2>/dev/null | head -50`;
    if (file_pattern) {
      cmd = `grep -rn ${excludeFlags} --include='${file_pattern}' "${pattern.replace(/"/g, '\\"')}" "${resolvedPath}" 2>/dev/null | head -50`;
    }

    const output = execSync(cmd, { encoding: 'utf-8', timeout: 15000, shell: DEFAULT_SHELL }).trim();

    if (!output) return `🔍 No matches found for "${pattern}" in ${resolvedPath}`;

    const lines = output.split('\n');
    return `🔍 Found ${lines.length}${lines.length >= 50 ? '+' : ''} matches for "${pattern}":\n\n${output}`;
  } catch (err) {
    if (err.status === 1) return `🔍 No matches found for "${pattern}"`;
    return `❌ Search error: ${err.message}`;
  }
}

/**
 * Tool: security_audit
 * A regex-based static pre-scan for common vulnerability classes (hardcoded
 * secrets, eval/exec sinks, SQL string concatenation, weak crypto, JWT
 * misconfiguration), so a request like "audit this app for security issues" is
 * grounded in real, file/line-cited candidate findings instead of the model
 * guessing or writing a generic checklist from memory. NOT a replacement for a real
 * SAST tool (semgrep, CodeQL, etc.) or a human review — pattern matching alone
 * can't understand data flow, so it will both miss real issues (anything that
 * doesn't match a pattern) and flag safe code that happens to match one (e.g. a
 * parameterized query whose SQL string is still built near a `+`). Findings are
 * candidates to go read in context, not a verdict — the tool's own output says so.
 */

const AUDIT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.kode', 'dist', 'build', 'out', '__pycache__',
  'venv', '.venv', 'vendor', 'target', '.next', '.cache', 'coverage',
]);

// Broader than embeddings.js's INDEXABLE_EXT — adds config/env formats where
// hardcoded secrets commonly live. This tool is scanning for risk, not indexing
// code for semantic search, so config and shell files matter here too.
const AUDIT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift', '.rb', '.php', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.sh', '.sql',
]);

const AUDIT_MAX_FILES = 1000;
const AUDIT_MAX_FILE_SIZE = 300 * 1024; // skip huge generated/data files as noise

/**
 * Recursively lists auditable files under root. Unlike embeddings.js's walkFiles,
 * this does NOT blanket-skip dotfiles: .env / .env.* are one of the most common
 * places a hardcoded secret actually lives, and would otherwise never be scanned.
 * Other dot-directories (.vscode, .idea, etc.) are still skipped as noise.
 */
function walkAuditFiles(root, dir = root, out = []) {
  if (out.length >= AUDIT_MAX_FILES) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (out.length >= AUDIT_MAX_FILES) break;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (AUDIT_SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      walkAuditFiles(root, full, out);
      continue;
    }

    const isEnvFile = entry.name === '.env' || entry.name.startsWith('.env.');
    const ext = path.extname(entry.name).toLowerCase();
    if (!isEnvFile && !AUDIT_EXTENSIONS.has(ext)) continue;

    try {
      const stat = fs.statSync(full);
      if (stat.size > AUDIT_MAX_FILE_SIZE || stat.size === 0) continue;
    } catch {
      continue;
    }

    out.push(path.relative(root, full));
  }

  return out;
}

/**
 * Rule set: each rule runs per-line (not multi-line) so a finding can cite an exact
 * line number. `redact: true` marks rules whose match IS (or contains, via
 * `secretGroup`) a real credential value — the actual secret text is masked in the
 * report rather than echoed in full, since tool output flows back into the
 * conversation and, on a cloud provider, off this machine entirely. `secretGroup`
 * (a regex capture-group index) narrows redaction to just the value, leaving
 * surrounding context (e.g. the `api_key:` prefix) readable; omitted, the whole
 * match is redacted.
 */
const AUDIT_RULES = [
  // --- Hardcoded secrets ---
  { category: 'hardcoded-secret', severity: 'HIGH', redact: true, secretGroup: 1,
    regex: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|password|passwd|pwd)\s*[:=]\s*['"]([A-Za-z0-9+/_\-]{12,})['"]/i,
    description: 'Possible hardcoded credential (key/token/password assigned to a literal string)' },
  { category: 'hardcoded-secret', severity: 'HIGH', redact: true,
    regex: /AKIA[0-9A-Z]{16}/,
    description: 'AWS Access Key ID literal' },
  { category: 'hardcoded-secret', severity: 'HIGH', redact: true,
    regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    description: 'Embedded private key header — the key file itself shouldn\'t be in the repo' },
  { category: 'hardcoded-secret', severity: 'HIGH', redact: true,
    regex: /xox[baprs]-[0-9A-Za-z-]{10,}/,
    description: 'Slack token literal' },
  { category: 'hardcoded-secret', severity: 'HIGH', redact: true,
    regex: /gh[pousr]_[A-Za-z0-9]{36,}/,
    description: 'GitHub personal access token literal' },
  { category: 'hardcoded-secret', severity: 'HIGH', redact: true,
    regex: /sk_live_[0-9a-zA-Z]{16,}/,
    description: 'Stripe live secret key literal' },
  { category: 'hardcoded-secret', severity: 'HIGH', redact: true,
    regex: /AIza[0-9A-Za-z\-_]{35}/,
    description: 'Google API key literal' },
  { category: 'hardcoded-secret', severity: 'MEDIUM', redact: true,
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    description: 'Literal JWT embedded in source — worth double-checking even if it looks like test/example data' },

  // --- eval/exec sinks (code / command injection) ---
  { category: 'eval-exec-sink', severity: 'HIGH',
    regex: /\beval\s*\(/,
    description: 'eval() — arbitrary code execution if the argument includes untrusted input' },
  { category: 'eval-exec-sink', severity: 'HIGH',
    regex: /new\s+Function\s*\(/,
    description: 'new Function(...) — dynamic code construction, same risk class as eval' },
  { category: 'eval-exec-sink', severity: 'HIGH',
    regex: /child_process\.exec\s*\(|require\(['"]child_process['"]\)\.exec\s*\(/,
    description: 'child_process.exec() — shell command injection risk if input isn\'t sanitized; prefer execFile/spawn with an argument array' },
  { category: 'eval-exec-sink', severity: 'HIGH',
    regex: /os\.system\s*\(/,
    description: 'os.system() — shell command injection risk; prefer subprocess.run([...]) without shell=True' },
  { category: 'eval-exec-sink', severity: 'HIGH',
    regex: /subprocess\.\w+\([^)]*shell\s*=\s*True/,
    description: 'subprocess call with shell=True — shell command injection risk if any argument includes untrusted input' },
  { category: 'eval-exec-sink', severity: 'HIGH',
    regex: /\b(?:shell_exec|passthru)\s*\(/,
    description: 'PHP shell-execution function — command injection risk if the argument includes untrusted input' },

  // --- SQL string concatenation / interpolation (SQL injection) ---
  { category: 'sql-injection', severity: 'MEDIUM',
    regex: /(['"])\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^'"]*\1\s*\+/i,
    description: 'SQL built via string concatenation — prefer parameterized queries/placeholders' },
  { category: 'sql-injection', severity: 'MEDIUM',
    regex: /f['"][^'"]*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^'"]*\{/i,
    description: 'SQL built via an f-string — prefer parameterized queries/placeholders' },
  { category: 'sql-injection', severity: 'MEDIUM',
    regex: /`[^`]*\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^`]*\$\{/i,
    description: 'SQL built via a template literal — prefer parameterized queries/placeholders' },

  // --- Weak crypto ---
  { category: 'weak-crypto', severity: 'MEDIUM',
    regex: /createHash\s*\(\s*['"]md5['"]\s*\)|hashlib\.md5\s*\(|MessageDigest\.getInstance\s*\(\s*["']MD5["']\s*\)/i,
    description: 'MD5 is cryptographically broken — fine for a non-security checksum, unsafe for passwords/signatures/integrity checks' },
  { category: 'weak-crypto', severity: 'MEDIUM',
    regex: /createHash\s*\(\s*['"]sha1['"]\s*\)|hashlib\.sha1\s*\(|MessageDigest\.getInstance\s*\(\s*["']SHA-?1["']\s*\)/i,
    description: 'SHA-1 is deprecated for security use (collision-broken) — unsafe for passwords/signatures' },
  { category: 'weak-crypto', severity: 'HIGH',
    regex: /Cipher\.getInstance\s*\(\s*["']DES|\bDES\/ECB\b/,
    description: 'DES has a 56-bit key and is trivially brute-forceable — use AES instead' },
  { category: 'weak-crypto', severity: 'HIGH',
    regex: /Cipher\.getInstance\s*\(\s*["']RC4/,
    description: 'RC4 has known biases/attacks — use a modern authenticated cipher (e.g. AES-GCM) instead' },
  { category: 'weak-crypto', severity: 'LOW',
    regex: /Math\.random\s*\(\s*\).{0,40}(?:token|password|secret|session|nonce|api[_-]?key)|(?:token|password|secret|session|nonce|api[_-]?key).{0,40}Math\.random\s*\(\s*\)/i,
    description: 'Math.random() is not cryptographically secure — use crypto.randomBytes()/randomUUID() for tokens, session IDs, or secrets' },

  // --- JWT misconfiguration ---
  { category: 'jwt-misconfig', severity: 'HIGH',
    regex: /algorithms?\s*[:=]\s*\[?\s*['"]none['"]/i,
    description: 'JWT "none" algorithm accepted — lets an attacker forge a token with no signature at all' },
  { category: 'jwt-misconfig', severity: 'HIGH',
    regex: /jwt\.decode\([^)]*verify\s*=\s*False/,
    description: 'jwt.decode() with verify=False — the signature is never checked, so any forged token is accepted' },
];

// .env files commonly store secrets as bare, UNQUOTED assignments (API_KEY=abc123,
// not API_KEY="abc123"), which none of AUDIT_RULES' quoted-string patterns match.
// Applied only to .env / .env.* files (see the isEnvFile check in security_audit) —
// scoping it that way, rather than matching any bare KEY=value anywhere, avoids
// flagging every ordinary shell variable assignment (PORT=3000, DEBUG=true) in
// non-.env files as a "secret". Still narrowed further by requiring the variable
// name itself to look secret-shaped.
const ENV_FILE_SECRET_RULE = {
  category: 'hardcoded-secret', severity: 'HIGH', redact: true, secretGroup: 1,
  regex: /^\s*[A-Za-z0-9_]*(?:SECRET|API[_-]?KEY|TOKEN|PASSWORD|PASSWD|PWD|AUTH|CREDENTIAL|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*=\s*(\S+)/i,
  description: '.env-style secret assignment — this file should not be committed to the repo (check .gitignore)',
};

/**
 * Masks a matched secret so the raw credential value never leaves this scan (and,
 * on a cloud provider, never leaves this machine) — keeps just enough of each end
 * to recognize the finding without exposing anything usable.
 */
function redactSecret(text) {
  if (!text) return '';
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}${'*'.repeat(Math.min(text.length - 8, 24))}${text.slice(-4)}`;
}

async function security_audit(params = {}, projectFolder) {
  if (!projectFolder) return '❌ Error: security_audit requires an active project folder.';

  const scopePath = params.path && String(params.path).trim();
  const root = scopePath
    ? (path.isAbsolute(scopePath) ? scopePath : path.resolve(projectFolder, scopePath))
    : projectFolder;

  if (!fs.existsSync(root)) return `❌ Error: "${root}" not found.`;

  const rootIsDir = fs.statSync(root).isDirectory();
  const relFiles = rootIsDir ? walkAuditFiles(root) : [path.basename(root)];

  if (relFiles.length === 0) {
    return `🛡️ security_audit: no auditable files found under "${scopePath || '.'}".`;
  }

  const findings = [];
  for (const relPath of relFiles) {
    const fullPath = rootIsDir ? path.join(root, relPath) : root;
    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue; // binary or unreadable — skip rather than fail the whole scan
    }

    const base = path.basename(relPath);
    const isEnvFile = base === '.env' || base.startsWith('.env.');
    const rulesToApply = isEnvFile ? [...AUDIT_RULES, ENV_FILE_SECRET_RULE] : AUDIT_RULES;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const rule of rulesToApply) {
        const match = line.match(rule.regex);
        if (!match) continue;

        let snippet = line.trim();
        if (rule.redact) {
          const target = rule.secretGroup ? match[rule.secretGroup] : match[0];
          if (target) snippet = snippet.split(target).join(redactSecret(target));
        }

        findings.push({
          file: relPath,
          line: i + 1,
          category: rule.category,
          severity: rule.severity,
          description: rule.description,
          snippet: snippet.slice(0, 200),
        });
      }
    }
  }

  if (findings.length === 0) {
    return `🛡️ security_audit scanned ${relFiles.length} file(s) under "${scopePath || '.'}" — no pattern-matched issues found.\n` +
      `(This is a regex pre-scan, not a full audit — it can't see logic/data-flow issues like broken access control or ` +
      `missing authorization checks. Still worth a manual review of auth, input validation, and access control.)`;
  }

  const severityRank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  findings.sort((a, b) =>
    severityRank[a.severity] - severityRank[b.severity] ||
    a.file.localeCompare(b.file) ||
    a.line - b.line
  );

  const counts = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});
  const countSummary = ['HIGH', 'MEDIUM', 'LOW'].filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(', ');
  const summaryLine = `🛡️ security_audit found ${findings.length} candidate issue(s) in ${relFiles.length} file(s) scanned (${countSummary}):`;

  const MAX_SHOWN = 60;
  const shown = findings.slice(0, MAX_SHOWN);
  const body = shown
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.category} — ${f.file}:${f.line}\n   ${f.description}\n   > ${f.snippet}`)
    .join('\n\n');

  let truncNote = '';
  if (findings.length > MAX_SHOWN) {
    const fullText = findings
      .map((f) => `[${f.severity}] ${f.category} — ${f.file}:${f.line}\n${f.description}\n> ${f.snippet}`)
      .join('\n\n');
    truncNote = `\n\n… ${findings.length - MAX_SHOWN} more finding(s) not shown.${saveFullOutput(projectFolder, 'security-audit', fullText)}`;
  }

  return `${summaryLine}\n\n${body}${truncNote}\n\n` +
    `⚠️ These are pattern-matched candidates, not confirmed vulnerabilities — read each one in its surrounding context before ` +
    `treating it as real, and note this pre-scan can't see logic/data-flow issues like broken access control or missing authorization checks.`;
}

/**
 * Resolves the project's git top-level, or null if projectFolder isn't inside a git
 * working tree. Used by the read/revert git tools (git_status, git_diff, git_revert)
 * which should fail clearly rather than silently operating on the wrong directory —
 * unlike git_checkpoint, which auto-inits a repo since it's meant to "just work".
 */
function gitToplevel(projectFolder) {
  if (!projectFolder) return null;
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: projectFolder,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    return top || null;
  } catch {
    return null;
  }
}

/** Consistent "not a git repo yet" error text pointing at the fix (git_checkpoint). */
function notAGitRepoError(projectFolder) {
  return `❌ Error: "${projectFolder}" is not (inside) a git repository yet. ` +
    'Call git_checkpoint to initialize one and create the first safety-net commit.';
}

/**
 * Tool: git_status
 * Shows the working tree status (branch + short status) — the first thing to check
 * before/after the agent makes a batch of edits.
 */
async function git_status(params, projectFolder) {
  if (!projectFolder) return '❌ Error: git_status requires an active project folder.';
  if (!gitToplevel(projectFolder)) return notAGitRepoError(projectFolder);

  try {
    const output = execFileSync('git', ['status', '--short', '--branch'], {
      cwd: projectFolder,
      encoding: 'utf-8',
      timeout: 15000,
    }).trim();
    return `📊 Git status:\n${output || '(clean — no changes since last checkpoint)'}`;
  } catch (err) {
    return `❌ git status failed: ${(err.stderr || err.message || '').toString().trim()}`;
  }
}

/**
 * Tool: git_diff
 * Shows an actual diff (not just a summary) so the model — and the user reviewing the
 * tool-execution log — can see exactly what changed before deciding to commit/keep it.
 */
async function git_diff(params = {}, projectFolder) {
  if (!projectFolder) return '❌ Error: git_diff requires an active project folder.';
  if (!gitToplevel(projectFolder)) return notAGitRepoError(projectFolder);

  const { path: filePath, staged } = params;
  const args = ['diff'];
  if (staged) args.push('--staged');
  if (filePath) args.push('--', filePath);

  try {
    const output = execFileSync('git', args, {
      cwd: projectFolder,
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
    }).trim();

    if (!output) return `📊 No ${staged ? 'staged ' : ''}changes${filePath ? ` in ${filePath}` : ''}.`;

    const maxLen = 6000;
    let truncated = output;
    let savedNote = '';
    if (output.length > maxLen) {
      truncated = output.substring(0, maxLen) + '\n\n... (diff truncated)';
      savedNote = saveFullOutput(projectFolder, 'git-diff', output);
    }
    return `📊 Git diff${filePath ? ` (${filePath})` : ''}:\n\n${truncated}${savedNote}`;
  } catch (err) {
    return `❌ git diff failed: ${(err.stderr || err.message || '').toString().trim()}`;
  }
}

/**
 * Tool: git_checkpoint
 * Stages everything and commits it as a labeled safety-net checkpoint, so risky edits
 * can always be undone with git_revert. Unlike the other git_* tools, this one
 * auto-initializes a repo the first time it's called — the whole point is that the
 * model (and the user) never have to think about git setup to get the safety net.
 */
async function git_checkpoint(params = {}, projectFolder) {
  if (!projectFolder) return '❌ Error: git_checkpoint requires an active project folder.';

  const message = (params.message && String(params.message).trim()) || 'Kode checkpoint';
  let initNote = '';

  try {
    if (!gitToplevel(projectFolder)) {
      execFileSync('git', ['init'], { cwd: projectFolder, encoding: 'utf-8', timeout: 10000 });
      // A commit needs an identity; only set one locally (this repo only) and only if
      // none is configured at all, so we never clobber a real user identity.
      try {
        execFileSync('git', ['config', 'user.name'], { cwd: projectFolder, encoding: 'utf-8' });
      } catch {
        execFileSync('git', ['config', 'user.email', 'kode-agent@local'], { cwd: projectFolder });
        execFileSync('git', ['config', 'user.name', 'Kode Agent'], { cwd: projectFolder });
      }
      initNote = `🆕 Initialized a new git repository in "${projectFolder}" for checkpointing.\n`;
    }

    execFileSync('git', ['add', '-A'], { cwd: projectFolder, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });

    // Nothing to commit is not an error — it just means the tree already matches the
    // last checkpoint (or the repo is genuinely empty).
    let staged;
    try {
      staged = execFileSync('git', ['diff', '--cached', '--stat'], { cwd: projectFolder, encoding: 'utf-8', timeout: 15000 }).trim();
    } catch {
      staged = '';
    }
    if (!staged) {
      return `${initNote}📊 Nothing to checkpoint — working tree already matches the last commit.`;
    }

    execFileSync('git', ['commit', '-m', `Kode checkpoint: ${message}`], {
      cwd: projectFolder,
      encoding: 'utf-8',
      timeout: 15000,
    });

    const shortHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectFolder, encoding: 'utf-8', timeout: 10000 }).trim();
    return `${initNote}✅ Checkpoint created (${shortHash}): "${message}"\n${staged}\n\nUse git_revert to undo back to a checkpoint if a later change goes wrong.`;
  } catch (err) {
    return `❌ git_checkpoint failed: ${(err.stderr || err.message || '').toString().trim()}`;
  }
}

/**
 * Tool: git_revert
 * The undo half of the checkpoint safety net.
 *   - With `file` and no `ref`: discards uncommitted changes to that one file only
 *     (safe — cannot lose a commit).
 *   - With `file` and `ref`: restores that one file's content from an earlier ref.
 *   - With no `file` and no `ref`: discards ALL uncommitted changes back to the last
 *     checkpoint (safe — does not move history, only resets the working tree).
 *   - With `ref` and no `file`: hard-resets the whole working tree AND branch history
 *     to that ref. This is destructive to any commits after it (though they remain
 *     recoverable via `git reflog` for a while) — always labeled with a warning.
 */
async function git_revert(params = {}, projectFolder) {
  if (!projectFolder) return '❌ Error: git_revert requires an active project folder.';
  if (!gitToplevel(projectFolder)) return notAGitRepoError(projectFolder);

  const { file, ref } = params;

  try {
    if (file) {
      const args = ref ? ['checkout', ref, '--', file] : ['checkout', 'HEAD', '--', file];
      execFileSync('git', args, { cwd: projectFolder, encoding: 'utf-8', timeout: 15000 });
      return `✅ Reverted "${file}" to ${ref || 'the last checkpoint'}.`;
    }

    if (ref) {
      execFileSync('git', ['reset', '--hard', ref], { cwd: projectFolder, encoding: 'utf-8', timeout: 15000 });
      return `⚠️ Hard-reset the whole project to "${ref}" — any commits after that point are no longer on this branch ` +
        `(recoverable for a while via "git reflog" if this was a mistake).`;
    }

    execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: projectFolder, encoding: 'utf-8', timeout: 15000 });
    return '✅ Discarded all uncommitted changes — working tree restored to the last checkpoint.';
  } catch (err) {
    return `❌ git_revert failed: ${(err.stderr || err.message || '').toString().trim()}`;
  }
}

/**
 * Tool: apply_patch
 * Applies one or more unified-diff hunks (the standard `diff -u` / `git diff` format)
 * to existing files, or creates new files from a `--- /dev/null` diff. Preferred over
 * edit_file for multi-hunk or multi-file changes: it's more token-efficient (the model
 * only writes the changed lines, not a whole old_content block to match verbatim) and
 * local models are far more reliable at producing a short diff than reproducing an
 * exact multi-line string. Falls back to a content-based search (see src/agent/patch.js)
 * when a hunk's line numbers are slightly off, which local models get wrong often.
 */
async function apply_patch(params = {}, projectFolder) {
  const { patch } = params;
  if (!patch || typeof patch !== 'string') {
    return '❌ Error: "patch" parameter is required (a unified diff, as produced by `diff -u` or `git diff`).';
  }

  let files;
  try {
    files = parseUnifiedDiff(patch);
  } catch (err) {
    return `❌ Error: could not parse the patch — ${err.message}. Make sure it's a standard unified diff with "--- "/"+++ " file headers and "@@ ... @@" hunk headers.`;
  }

  if (files.length === 0) {
    return '❌ Error: no file hunks found in the patch text.';
  }

  const results = [];
  for (const fileEntry of files) {
    const targetRel = fileEntry.newPath && fileEntry.newPath !== '/dev/null' ? fileEntry.newPath : fileEntry.oldPath;
    if (!targetRel || targetRel === '/dev/null') {
      results.push('❌ Skipped a hunk with no resolvable file path.');
      continue;
    }

    const resolvedPath = path.isAbsolute(targetRel) ? targetRel : path.resolve(projectFolder || process.cwd(), targetRel);

    try {
      const isNewFile = fileEntry.oldPath === '/dev/null' || !fs.existsSync(resolvedPath);
      let newContent;

      if (isNewFile) {
        newContent = fileEntry.hunks
          .flatMap(h => h.lines.filter(l => l.type === '+').map(l => l.text))
          .join('\n');
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      } else {
        const original = fs.readFileSync(resolvedPath, 'utf-8');
        newContent = applyHunksToContent(original, fileEntry.hunks);
      }

      fs.writeFileSync(resolvedPath, newContent, 'utf-8');
      const hunkWord = fileEntry.hunks.length === 1 ? 'hunk' : 'hunks';
      results.push(`✅ ${isNewFile ? 'Created' : 'Patched'} ${targetRel} (${fileEntry.hunks.length} ${hunkWord}).${syntaxCheckSuffix(resolvedPath)}`);
    } catch (err) {
      // PatchError carries a specific, actionable message (hunk not found, etc.);
      // anything else (fs permission errors and the like) still gets reported, just
      // without that same guarantee of being immediately actionable.
      const prefix = err instanceof PatchError ? '' : '(unexpected) ';
      results.push(`❌ Failed to patch ${targetRel}: ${prefix}${err.message}`);
    }
  }

  return results.join('\n');
}

/**
 * Tool: run_tests
 * First-class test-runner tool. Wraps `npm test` (or a custom command) with a longer
 * timeout than a normal run_command call and a summary geared at the pass/fail
 * question — encourages the model to habitually verify its own edits instead of
 * assuming they work, which matters more for local models than cloud ones since
 * they're more prone to subtle mistakes.
 */
async function run_tests(params = {}, projectFolder, toolContext = {}) {
  const command = (params.command && String(params.command).trim()) || 'npm test';
  const TEST_TIMEOUT = 180000; // 3 minutes — test suites run longer than a typical command

  try {
    const { stdout: rawStdout, stderr: rawStderr, code, timedOut, aborted } = await runShellCommandAsync(command, {
      cwd: projectFolder || process.cwd(),
      timeoutMs: TEST_TIMEOUT,
      maxBuffer: 4 * 1024 * 1024,
      signal: toolContext.signal,
    });

    if (aborted) {
      return `🛑 Tests stopped by user:\n$ ${command}` +
             (rawStdout.trim() ? `\n\nPartial output:\n${rawStdout.trim().substring(0, 3000)}` : '');
    }

    if (timedOut) {
      return `⏱️ Tests timed out after ${TEST_TIMEOUT / 1000}s:\n$ ${command}` +
             (rawStdout.trim() ? `\n\nPartial output:\n${rawStdout.trim().substring(0, 3000)}` : '');
    }

    if (code !== 0) {
      let result = `❌ Tests failed (exit code ${code ?? 'unknown'}):\n$ ${command}`;
      if (rawStdout.trim()) result += `\n\nstdout:\n${rawStdout.trim().substring(0, 3000)}`;
      if (rawStderr.trim()) result += `\n\nstderr:\n${rawStderr.trim().substring(0, 2000)}`;
      return result;
    }

    const output = rawStdout.trim();
    const maxLen = 6000;
    let truncated = output;
    let savedNote = '';
    if (output.length > maxLen) {
      truncated = output.substring(0, maxLen) + '\n\n... (output truncated)';
      savedNote = saveFullOutput(projectFolder, 'test-output', output);
    }
    return `✅ Tests passed:\n$ ${command}\n\n${truncated || '(no output)'}${savedNote}`;
  } catch (err) {
    return `❌ Failed to run tests: ${err.message}\n$ ${command}`;
  }
}

/**
 * Tool: write_plan
 * Lays out (or updates) a step-by-step checklist for a multi-step task — gives the
 * model (especially smaller local models, which lose track of multi-step tasks
 * easily) a habit of committing to its steps explicitly before acting, then checking
 * items off as it goes. The formatted checklist becomes part of the tool-execution
 * log the user sees in the UI, so it doubles as visible progress reporting.
 *
 * Persisted to <project>/.kode/plan.json (see agent/plan.js) whenever a project
 * folder is active, so the plan — and how far through it the agent had gotten —
 * survives context trims, app restarts, and starting a fresh chat on the same
 * project. getSystemPrompt resurfaces an incomplete plan at the start of a new turn
 * so the model can pick up where it left off instead of the task being silently
 * forgotten. Cleared automatically once every step is marked done.
 */
async function write_plan(params = {}, projectFolder) {
  const { steps } = params;
  if (!Array.isArray(steps) || steps.length === 0) {
    return '❌ Error: "steps" parameter is required — an array of {text, status} objects.';
  }

  const { text } = plan.formatPlan(steps);

  if (projectFolder) {
    if (plan.isPlanComplete(steps)) {
      plan.clearPlan(projectFolder);
    } else {
      plan.savePlan(projectFolder, steps);
    }
  }

  return text;
}

/**
 * Tool: index_codebase
 * Builds/rebuilds the local semantic search index for the active project (see
 * src/agent/embeddings.js). Requires an Ollama embedding model to be pulled
 * (`ollama pull nomic-embed-text` by default) — cloud providers don't support this,
 * since it's specifically a "make local models competitive at codebase understanding"
 * feature. Call this once when starting work on a project (or after large changes),
 * then use semantic_search instead of guessing grep patterns.
 */
async function index_codebase(params = {}, projectFolder, toolContext = {}) {
  if (!projectFolder) return '❌ Error: index_codebase requires an active project folder.';

  const client = toolContext.embedClient || toolContext.ollamaClient;
  if (!client || typeof client.embed !== 'function') {
    return '❌ Error: semantic search requires the Ollama provider (embeddings aren\'t available for cloud providers). ' +
      'Switch Settings → Provider to Ollama and make sure an embedding model is pulled, e.g. "ollama pull nomic-embed-text".';
  }

  const model = (params.model && String(params.model).trim()) || embeddings.DEFAULT_EMBED_MODEL;

  try {
    const result = await embeddings.buildIndex(projectFolder, client, model);
    const truncNote = result.truncated ? `\n⚠️ Project has more than the indexed file cap — some files were skipped.` : '';
    return `✅ Indexed ${result.fileCount} files (${result.chunkCount} chunks) with "${result.model}".${truncNote}\nUse semantic_search to query it.`;
  } catch (err) {
    return `❌ index_codebase failed: ${err.message}\n(Is Ollama running with "${model}" pulled? Try: ollama pull ${model})`;
  }
}

/**
 * Tool: semantic_search
 * Meaning-based search over the index built by index_codebase — finds relevant code
 * by what it *does*, not just literal string matches like search_files. Falls back to
 * a clear "no index yet" message rather than silently returning nothing, so the model
 * knows to call index_codebase first.
 */
async function semantic_search(params = {}, projectFolder, toolContext = {}) {
  if (!projectFolder) return '❌ Error: semantic_search requires an active project folder.';
  const { query, limit } = params;
  if (!query || typeof query !== 'string') {
    return '❌ Error: "query" parameter is required (a natural-language description of what you\'re looking for).';
  }

  const client = toolContext.embedClient || toolContext.ollamaClient;
  if (!client || typeof client.embed !== 'function') {
    return '❌ Error: semantic search requires the Ollama provider with an embedding model pulled (e.g. "ollama pull nomic-embed-text").';
  }

  try {
    const results = await embeddings.search(projectFolder, client, query, { limit: limit || 8 });
    if (results === null) {
      return '🔍 No semantic index found for this project yet. Call index_codebase first, then retry.';
    }
    if (results.length === 0) {
      return `🔍 No results for "${query}".`;
    }

    const formatted = results
      .map((r, i) => `${i + 1}. [score ${r.score.toFixed(3)}] ${r.file} (chunk ${r.chunkIndex})\n   ${r.preview.replace(/\n/g, '\n   ')}`)
      .join('\n\n');
    return `🔍 Semantic search results for "${query}":\n\n${formatted}\n\n(Use read_file to see the full file around a promising match.)`;
  } catch (err) {
    return `❌ semantic_search failed: ${err.message}`;
  }
}

/**
 * Tool: save_memory
 * Persists a durable fact/note for this project to <project>/.kode/memory.json, so it
 * survives context trims, app restarts, and new chats — unlike the in-session rolling
 * summary, this is explicit, inspectable, and only written when the model decides
 * something is actually worth remembering long-term.
 */
async function save_memory(params, projectFolder, toolContext = {}) {
  const { key, value, tags } = params;

  if (!projectFolder) {
    return '❌ Error: save_memory requires an active project folder.';
  }
  if (!key || typeof key !== 'string') {
    return '❌ Error: "key" parameter is required (a short label for this memory, e.g. "dev-server-port").';
  }
  if (typeof value !== 'string' || !value.trim()) {
    return '❌ Error: "value" parameter is required (the fact/note to remember).';
  }

  // Best-effort: embed the entry so recall_memory can do meaning-based search later,
  // not just keyword overlap (see memory.semanticSearchMemory). Never blocks the
  // save — embeddings only work with the Ollama provider (toolContext.embedClient is
  // null for cloud providers, see core.js's toolContext construction), and a save
  // should still succeed even if the embedding call itself fails.
  let vector = null;
  const client = toolContext.embedClient;
  if (client && typeof client.embed === 'function') {
    try {
      const embedText = `${key.trim()} ${value.trim()} ${Array.isArray(tags) ? tags.join(' ') : ''}`.trim();
      const [computed] = await client.embed(embeddings.DEFAULT_EMBED_MODEL, [embedText]);
      if (Array.isArray(computed)) vector = computed;
    } catch (err) {
      console.warn('[save_memory] Failed to compute embedding, saving without one:', err.message);
    }
  }

  try {
    const entry = memory.upsertMemoryEntry(projectFolder, key.trim(), value.trim(), Array.isArray(tags) ? tags : [], vector);
    return `🧠 Saved to project memory: [${entry.key}] ${entry.value}`;
  } catch (err) {
    return `❌ Error saving memory: ${err.message}`;
  }
}

/**
 * Tool: recall_memory
 * Searches previously-saved project memory for a natural-language query. Uses
 * meaning-based (embedding) search when an Ollama embedding client is available and
 * at least one saved entry has a stored vector (see save_memory), falling back to
 * plain keyword overlap otherwise — so this works the same as before on the cloud
 * providers or for entries saved before this existed. Use this when something might
 * have been established earlier in this project (conventions, credentials
 * locations, prior research) but isn't in the current context window.
 */
async function recall_memory(params, projectFolder, toolContext = {}) {
  const { query } = params;

  if (!projectFolder) {
    return '❌ Error: recall_memory requires an active project folder.';
  }

  try {
    let results = [];
    let usedSemantic = false;
    const client = toolContext.embedClient;
    if (client && typeof client.embed === 'function' && query && query.trim()) {
      try {
        results = await memory.semanticSearchMemory(projectFolder, client, query.trim(), 8);
        usedSemantic = results.length > 0;
      } catch (err) {
        console.warn('[recall_memory] Semantic search failed, falling back to keyword search:', err.message);
      }
    }

    if (!usedSemantic) {
      results = memory.searchMemory(projectFolder, query || '', 8);
    }

    if (results.length === 0) {
      return query
        ? `🧠 No saved memory matched "${query}".`
        : '🧠 No memory saved for this project yet.';
    }
    const matchNote = usedSemantic ? ' (semantic match)' : '';
    return `🧠 Recalled memory${query ? ` for "${query}"` : ''}${matchNote}:\n${memory.formatMemoryEntries(results)}`;
  } catch (err) {
    return `❌ Error recalling memory: ${err.message}`;
  }
}

/**
 * Tool: ask_user
 * Pauses the current turn to ask the person a direct question — for a genuine
 * blocker where the agent truly cannot reasonably proceed without input only they
 * can give (a choice between meaningfully different approaches, a missing
 * credential/detail that can't be discovered another way, confirmation before an
 * action outside what run_command's own risky-command gate already covers). This is
 * NOT for routine progress updates, or anything the agent could reasonably decide
 * on its own — see the system prompt's "Direct Action vs Planning" guidance:
 * default to just doing the work, and only reach for this when actually stuck.
 *
 * Follows the same IPC round-trip pattern as run_command's risky-command
 * confirmation (see main.js's makeAskUserCallback / makeConfirmCommandCallback):
 * toolContext.askUser sends the question to the renderer, which shows it inline
 * (with the given options as quick-pick buttons, if any, plus a free-text field
 * either way) and this call blocks until the person answers or a generous timeout
 * elapses. Only available when the caller (main.js) supplies toolContext.askUser —
 * e.g. not when processMessage is driven headlessly with no UI to ask through.
 */
async function ask_user(params, projectFolder, toolContext = {}) {
  const { question, options } = params;

  if (!question || typeof question !== 'string' || !question.trim()) {
    return '❌ Error: "question" parameter is required (what you need to ask the user).';
  }

  const normalizedOptions = Array.isArray(options)
    ? options.filter((o) => typeof o === 'string' && o.trim()).slice(0, 6).map((o) => o.trim())
    : [];

  if (typeof toolContext.askUser !== 'function') {
    return '❌ ask_user is unavailable right now (no UI to ask through). ' +
      'Proceed with your best judgment instead, or explain in your response what you need and why you\'re stuck.';
  }

  try {
    const answer = await toolContext.askUser(question.trim(), normalizedOptions);
    if (answer === null || answer === undefined || (typeof answer === 'string' && !answer.trim())) {
      return '⏱️ No response — the user did not answer in time. Proceed with your best judgment, ' +
        'or clearly state what you need and stop rather than guessing on something that matters.';
    }
    return `💬 User answered: ${answer}`;
  } catch (err) {
    return `❌ Error asking user: ${err.message}`;
  }
}

// Export all tools as a name→handler map
const tools = {
  create_file,
  edit_file,
  read_file,
  run_command,
  list_directory,
  http_request,
  search_files,
  security_audit,
  firecrawl_scrape,
  web_search,
  save_memory,
  recall_memory,
  git_status,
  git_diff,
  git_checkpoint,
  git_revert,
  apply_patch,
  run_tests,
  write_plan,
  index_codebase,
  semantic_search,
  ask_user,
};

/**
 * JSON-schema tool definitions in Ollama's native function-calling format
 * (https://ollama.com/blog/tool-support). Only a subset of local models
 * (llama3.1+, qwen2.5+, mistral-nemo, command-r, firefunction) actually honor
 * the `tools` field — see agent/prompts.js `supportsNativeToolCalling()`.
 * For every other model this is simply ignored and the markdown ```tool```
 * block format in the system prompt is used instead.
 */
const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create a new file with the given content. Creates parent directories automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, relative to the project folder or absolute.' },
          content: { type: 'string', description: 'Full file content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit an existing file by replacing an exact block of old_content with new_content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit.' },
          old_content: { type: 'string', description: 'Exact existing text to find.' },
          new_content: { type: 'string', description: 'Text to replace it with.' },
        },
        required: ['path', 'old_content', 'new_content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read and return the contents of a file (capped at 50KB per call). For a file larger than that, or to jump straight to a known section, pass offset/limit to read a specific range of lines instead of just the beginning.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read.' },
          offset: { type: 'number', description: 'First line to read (1-indexed). Omit to start from the beginning.' },
          limit: { type: 'number', description: 'Max number of lines to read from offset. Defaults to 2000.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command (zsh/bash) and return its output. Long-running server commands are backgrounded automatically.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the contents of a directory with file type and size info.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: 'Make an HTTP/HTTPS request (GET, POST, etc.) — useful for API testing and vulnerability probing.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target URL.' },
          method: { type: 'string', description: 'HTTP method, defaults to GET.' },
          headers: { type: 'object', description: 'Optional request headers.' },
          body: { type: 'string', description: 'Optional request body.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Grep-like search for a pattern across project files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Text or regex pattern to search for.' },
          path: { type: 'string', description: 'Directory to search in, defaults to project root.' },
          file_pattern: { type: 'string', description: 'Glob to filter which files are searched, e.g. "*.js".' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'security_audit',
      description: 'Regex-based static pre-scan for common vulnerability classes: hardcoded secrets, eval/exec sinks (code/command injection), SQL string concatenation, weak crypto (MD5/SHA1/DES/RC4/insecure random), and JWT misconfiguration ("none" algorithm, unverified decode). Returns file:line-cited candidate findings with severity — a starting point to ground a security review in real matches, not a substitute for reading the code or a real SAST tool.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory to scan, defaults to the whole project.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'firecrawl_scrape',
      description: 'Extract clean Markdown text from a URL (documentation, CVE pages, JS-rendered sites). Requires FIRECRAWL_API_KEY to be configured.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to scrape.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web via Brave Search for current information not available locally or in training data. Requires BRAVE_SEARCH_API_KEY. Follow up with firecrawl_scrape to read a full page, and save_memory to keep useful findings.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Persist a durable fact or note about this project to long-term memory, so it survives context trims, app restarts, and new chats. Use for things worth remembering across sessions (conventions, decisions, environment quirks, research findings) — not for transient conversation details.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short label for this memory, e.g. "dev-server-port" or "auth-flow-decision".' },
          value: { type: 'string', description: 'The fact or note to remember.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional keywords to help find this later.' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: 'Search this project\'s long-term memory for previously-saved facts/notes that might not be in the current context window. Uses meaning-based (semantic) search when available, so natural-language phrasing works even without exact keyword matches.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for. Leave empty to list the most recently saved memories.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show the project\'s git working-tree status (branch + changed files). Use before/after a batch of edits.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show the actual diff of uncommitted changes (or a specific file), so you can review exactly what changed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional: limit the diff to this file.' },
          staged: { type: 'boolean', description: 'Optional: show staged changes instead of the working tree.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_checkpoint',
      description: 'Stage and commit all current changes as a labeled safety-net checkpoint (auto-initializes a git repo on first use). Call this before a risky multi-file change, and after finishing a working change, so git_revert can always undo back to a known-good point.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Short label for this checkpoint, e.g. "before refactoring auth".' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_revert',
      description: 'Undo changes using git. With no params, discards all uncommitted changes back to the last checkpoint (safe). With "file", reverts just that file. With "ref" (a commit hash) and no file, hard-resets the WHOLE project to that commit — destructive to later history, use with care.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Optional: only revert this one file.' },
          ref: { type: 'string', description: 'Optional: a git ref/commit hash to revert to. Defaults to the last commit (HEAD).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Apply a unified diff (standard `diff -u` / `git diff` format) to one or more files — creates new files from a "--- /dev/null" diff, or patches existing ones by hunk. Prefer this over edit_file for multi-line or multi-file changes: it is more token-efficient and more reliable than reproducing an exact old_content block.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'The full unified diff text, with --- / +++ file headers and @@ ... @@ hunk headers.' },
        },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: 'Run the project\'s test suite (npm test by default, or a custom command) and report pass/fail with output. Call this after making code changes to verify they actually work, not just that they compiled.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Optional custom test/lint command. Defaults to "npm test".' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_plan',
      description: 'Lay out (or update) an explicit step-by-step plan for a multi-step task, as a checklist. Call once at the start of a vague/complex request to commit to a plan, then call again with updated statuses as steps complete — keeps long tasks on track and shows the user visible progress.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'Ordered list of steps.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'What this step does.' },
                status: { type: 'string', description: '"pending", "in_progress", or "done".' },
              },
              required: ['text'],
            },
          },
        },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'index_codebase',
      description: 'Build (or rebuild) a local semantic search index for this project using an Ollama embedding model. Requires the Ollama provider with an embedding model pulled (default "nomic-embed-text"). Call once at the start of work on an unfamiliar project, then use semantic_search instead of guessing grep patterns.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Optional embedding model name. Defaults to "nomic-embed-text".' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'semantic_search',
      description: 'Search the codebase by meaning, not just literal text (unlike search_files) — e.g. "where is the login flow handled". Requires index_codebase to have been run first.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language description of what you\'re looking for.' },
          limit: { type: 'number', description: 'Max results to return, defaults to 8.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Pause and ask the user a direct question when genuinely blocked and unable to proceed without their input — a choice only they can make, a missing detail/credential, or confirmation before something you\'re unsure about. Not for routine updates or anything you could reasonably decide yourself; default to just doing the work.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask, in plain language.' },
          options: { type: 'array', items: { type: 'string' }, description: 'Optional short button labels for the user to pick from (e.g. ["Option A", "Option B"]). Omit for a free-text/open question.' },
        },
        required: ['question'],
      },
    },
  },
];

module.exports = tools;
module.exports.TOOL_SCHEMAS = TOOL_SCHEMAS;
// Exposed for AgentCore's post-"Done" verification gate (see core.js _verifyDoneClaim)
// — not a model-callable tool, just the same write-time check create_file/edit_file/
// apply_patch already run, reused so the model can't just ignore the inline note.
// Defined non-enumerable so it doesn't show up in Object.keys(tools) — the dispatch
// map iterated by getAvailableToolNames() and the "TOOL_SCHEMAS covers every tool
// name" test (tools.test.js), which both assume every enumerable function here is a
// real model-callable tool.
Object.defineProperty(module.exports, 'quickSyntaxCheck', {
  value: quickSyntaxCheck,
  enumerable: false,
});

// Tools with no side effects — safe for AgentCore to run concurrently with each
// other when the model requests several in the same turn (see core.js's tool-
// execution loop, which batches consecutive calls satisfying this check via
// Promise.all instead of awaiting them one at a time). Deliberately conservative:
// anything that writes to disk, touches git state, runs a shell command, or could
// otherwise race with — or needs to see the effect of — a concurrent call stays off
// this list and runs alone, in order, same as before. Notably excludes
// index_codebase (writes the embedding index to disk) even though semantic_search
// (a pure read of that index) is included.
const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'security_audit',
  'git_status',
  'git_diff',
  'web_search',
  'firecrawl_scrape',
  'recall_memory',
  'semantic_search',
]);

/**
 * Whether one tool call is safe to run in parallel with other read-only calls.
 * Name-based for everything except http_request, which is only read-only when its
 * method is GET/HEAD — POST/PUT/DELETE/etc. are side-effecting (the whole point of
 * the call is usually to submit something) and get treated like create_file/
 * run_command: run alone, never batched with anything else.
 */
function isReadOnlyToolCall(toolName, params) {
  if (toolName === 'http_request') {
    const method = ((params && params.method) || 'GET').toString().toUpperCase();
    return method === 'GET' || method === 'HEAD';
  }
  return READ_ONLY_TOOLS.has(toolName);
}

// Both non-enumerable for the same reason as quickSyntaxCheck above: READ_ONLY_TOOLS
// isn't a function so Object.keys(tools).filter(typeof === 'function') already
// ignores it, but isReadOnlyToolCall is a function and would otherwise be mistaken
// for a 21st model-callable tool.
Object.defineProperty(module.exports, 'READ_ONLY_TOOLS', {
  value: READ_ONLY_TOOLS,
  enumerable: false,
});
Object.defineProperty(module.exports, 'isReadOnlyToolCall', {
  value: isReadOnlyToolCall,
  enumerable: false,
});
