'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync, spawn } = require('child_process');
const memory = require('./memory');
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
 * the whole agent loop indefinitely (run_command has its own timeout via execSync,
 * but the plain `fetch`-based tools didn't have an equivalent). Wraps fetch with an
 * AbortController so a slow/dead server fails fast with a clear message instead.
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
async function firecrawl_scrape(params) {
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
      const truncated = content.length > maxLen ? content.substring(0, maxLen) + '\n\n... (truncated)' : content;
      return `🌐 Scraped Content (Markdown) from ${url}:\n\n${truncated}`;
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
 * Reads and returns the contents of a file, capped at 50KB.
 */
async function read_file(params, projectFolder) {
  const { path: filePath } = params;

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

    if (stats.size > MAX_FILE_READ_SIZE) {
      // Read only the first 50KB
      const fd = fs.openSync(resolvedPath, 'r');
      const buffer = Buffer.alloc(MAX_FILE_READ_SIZE);
      fs.readSync(fd, buffer, 0, MAX_FILE_READ_SIZE, 0);
      fs.closeSync(fd);
      const content = buffer.toString('utf-8');
      return `📄 ${resolvedPath} (${stats.size} bytes, showing first 50KB):\n\n${content}\n\n⚠️ File truncated — showing first 50KB of ${stats.size} bytes.`;
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    return `📄 ${resolvedPath} (${stats.size} bytes):\n\n${content}`;
  } catch (err) {
    return `❌ Error reading file "${filePath}": ${err.message}`;
  }
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

    const stdout = execSync(command, {
      timeout: cmdTimeout,
      encoding: 'utf-8',
      shell: DEFAULT_SHELL,
      cwd: projectFolder || process.cwd(),
      maxBuffer: 2 * 1024 * 1024, // 2MB for scan outputs
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const output = stdout.trim();
    if (output.length === 0) {
      return `${riskWarning}✅ Command executed successfully (no output):\n$ ${command}`;
    }
    // Truncate very long output (5KB for scan results)
    const maxLen = 5000;
    const truncated = output.length > maxLen ? output.substring(0, maxLen) + '\n\n... (output truncated)' : output;
    return `${riskWarning}✅ Command output:\n$ ${command}\n\n${truncated}`;
  } catch (err) {
    const exitCode = err.status || 'unknown';
    const stdout = (err.stdout || '').trim();
    const stderr = (err.stderr || '').trim();

    if (err.killed) {
      return `⏱️ Command timed out after ${cmdTimeout / 1000} seconds:\n$ ${command}` +
             (stdout ? `\n\nPartial output:\n${stdout.substring(0, 2000)}` : '') +
             (stderr ? `\n\nPartial stderr:\n${stderr.substring(0, 1000)}` : '');
    }

    let result = `❌ Command failed (exit code ${exitCode}):\n$ ${command}`;
    if (stdout) result += `\n\nstdout:\n${stdout.substring(0, 2000)}`;
    if (stderr) result += `\n\nstderr:\n${stderr.substring(0, 2000)}`;
    return result;
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
async function search_files(params, projectFolder) {
  const { pattern, path: searchPath = '.', file_pattern = '' } = params;

  if (!pattern) return '❌ Error: "pattern" parameter is required.';

  try {
    const resolvedPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(projectFolder || process.cwd(), searchPath);

    let cmd = `grep -rn --include='*' "${pattern.replace(/"/g, '\\"')}" "${resolvedPath}" 2>/dev/null | head -50`;
    if (file_pattern) {
      cmd = `grep -rn --include='${file_pattern}' "${pattern.replace(/"/g, '\\"')}" "${resolvedPath}" 2>/dev/null | head -50`;
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
    const truncated = output.length > maxLen ? output.substring(0, maxLen) + '\n\n... (diff truncated)' : output;
    return `📊 Git diff${filePath ? ` (${filePath})` : ''}:\n\n${truncated}`;
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
async function run_tests(params = {}, projectFolder) {
  const command = (params.command && String(params.command).trim()) || 'npm test';
  const TEST_TIMEOUT = 180000; // 3 minutes — test suites run longer than a typical command

  try {
    const stdout = execSync(command, {
      timeout: TEST_TIMEOUT,
      encoding: 'utf-8',
      shell: DEFAULT_SHELL,
      cwd: projectFolder || process.cwd(),
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = stdout.trim();
    const maxLen = 6000;
    const truncated = output.length > maxLen ? output.substring(0, maxLen) + '\n\n... (output truncated)' : output;
    return `✅ Tests passed:\n$ ${command}\n\n${truncated || '(no output)'}`;
  } catch (err) {
    if (err.killed) {
      return `⏱️ Tests timed out after ${TEST_TIMEOUT / 1000}s:\n$ ${command}`;
    }
    const stdout = (err.stdout || '').trim();
    const stderr = (err.stderr || '').trim();
    let result = `❌ Tests failed (exit code ${err.status ?? 'unknown'}):\n$ ${command}`;
    if (stdout) result += `\n\nstdout:\n${stdout.substring(0, 3000)}`;
    if (stderr) result += `\n\nstderr:\n${stderr.substring(0, 2000)}`;
    return result;
  }
}

/**
 * Tool: write_plan
 * Stateless planning/todo tool. Doesn't persist anything — it exists to give the model
 * (especially smaller local models, which lose track of multi-step tasks easily) a
 * habit of laying out its steps explicitly before acting, and re-calling this to check
 * items off as it goes. The formatted checklist becomes part of the tool-execution log
 * the user sees in the UI, so it doubles as visible progress reporting.
 */
async function write_plan(params = {}) {
  const { steps } = params;
  if (!Array.isArray(steps) || steps.length === 0) {
    return '❌ Error: "steps" parameter is required — an array of {text, status} objects.';
  }

  const lines = steps.map((s, i) => {
    const text = (s && s.text) ? String(s.text) : `Step ${i + 1}`;
    const status = s && typeof s.status === 'string' ? s.status.toLowerCase() : 'pending';
    const box = status === 'done' || status === 'completed' ? '[x]'
      : status === 'in_progress' || status === 'doing' ? '[~]'
      : '[ ]';
    return `${box} ${text}`;
  });

  const done = lines.filter(l => l.startsWith('[x]')).length;
  return `📋 Plan (${done}/${lines.length} done):\n${lines.join('\n')}`;
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
async function save_memory(params, projectFolder) {
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

  try {
    const entry = memory.upsertMemoryEntry(projectFolder, key.trim(), value.trim(), Array.isArray(tags) ? tags : []);
    return `🧠 Saved to project memory: [${entry.key}] ${entry.value}`;
  } catch (err) {
    return `❌ Error saving memory: ${err.message}`;
  }
}

/**
 * Tool: recall_memory
 * Searches previously-saved project memory by keyword overlap. Use this when
 * something might have been established earlier in this project (conventions,
 * credentials locations, prior research) but isn't in the current context window.
 */
async function recall_memory(params, projectFolder) {
  const { query } = params;

  if (!projectFolder) {
    return '❌ Error: recall_memory requires an active project folder.';
  }

  try {
    const results = memory.searchMemory(projectFolder, query || '', 8);
    if (results.length === 0) {
      return query
        ? `🧠 No saved memory matched "${query}".`
        : '🧠 No memory saved for this project yet.';
    }
    return `🧠 Recalled memory${query ? ` for "${query}"` : ''}:\n${memory.formatMemoryEntries(results)}`;
  } catch (err) {
    return `❌ Error recalling memory: ${err.message}`;
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
      description: 'Read and return the contents of a file (capped at 50KB).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read.' },
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
      description: 'Search this project\'s long-term memory for previously-saved facts/notes that might not be in the current context window.',
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
];

module.exports = tools;
module.exports.TOOL_SCHEMAS = TOOL_SCHEMAS;
