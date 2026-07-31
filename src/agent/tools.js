'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const memory = require('./memory');

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
    return `✅ File created successfully: ${resolvedPath} (${stats.size} bytes)`;
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
           `   Replaced ${occurrences} occurrence(s) of the specified text.`;
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
 */
async function run_command(params, projectFolder) {
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
  // remote-code-execution shape. We can't gate these on a real user confirmation
  // without new IPC plumbing between the agent loop and the UI, so instead we run
  // them but make sure the risk is visible in the tool result the model/user sees.
  const riskyButAllowed = [
    { pattern: /curl[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, label: 'piping a downloaded script directly into a shell' },
    { pattern: /wget[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, label: 'piping a downloaded script directly into a shell' },
    { pattern: /base64\s+-d[^|]*\|\s*(ba)?sh\b/i, label: 'executing a base64-decoded payload' },
    { pattern: /eval\s*\(\s*(curl|wget)/i, label: 'evaluating remotely-fetched code' },
  ];
  let riskWarning = '';
  for (const { pattern, label } of riskyButAllowed) {
    if (pattern.test(command)) {
      riskWarning = `⚠️ Risk note: this command involves ${label} — review it carefully before trusting the output.\n\n`;
      break;
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
              // Still running after 3s = server started successfully
              child.stdout.removeAllListeners('data');
              child.stderr.removeAllListeners('data');
              child.unref(); // Detach from parent process
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

        let result = `✅ Server started (PID: ${startResult.pid}):\n$ ${command}\n🌐 Access at: http://localhost:${port}`;
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
];

module.exports = tools;
module.exports.TOOL_SCHEMAS = TOOL_SCHEMAS;
