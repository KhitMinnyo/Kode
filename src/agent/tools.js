'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const MAX_FILE_READ_SIZE = 50 * 1024; // 50KB
const COMMAND_TIMEOUT = 30000; // 30 seconds

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

    // Count occurrences
    const occurrences = currentContent.split(old_content).length - 1;

    const updatedContent = currentContent.replace(old_content, new_content);
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

  // Safety check: block extremely destructive commands
  const dangerous = [
    /^rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,  // rm -rf /
    /^rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/\*|~\/\*)$/,  // rm -rf /* or ~/*
    /mkfs\./,
    /dd\s+if=.*of=\/dev\//,
    /:(){ :\|:& };:/,  // Fork bomb
  ];

  for (const pattern of dangerous) {
    if (pattern.test(command)) {
      return `🚫 Blocked: This command appears to be destructive and has been blocked for safety.\nCommand: ${command}`;
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
        const shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
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
        return result;
      } catch (err) {
        return `❌ Failed to start server: ${err.message}`;
      }
    }

    const stdout = execSync(command, {
      timeout: cmdTimeout,
      encoding: 'utf-8',
      shell: '/bin/zsh',
      cwd: projectFolder || process.cwd(),
      maxBuffer: 2 * 1024 * 1024, // 2MB for scan outputs
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const output = stdout.trim();
    if (output.length === 0) {
      return `✅ Command executed successfully (no output):\n$ ${command}`;
    }
    // Truncate very long output (5KB for scan results)
    const maxLen = 5000;
    const truncated = output.length > maxLen ? output.substring(0, maxLen) + '\n\n... (output truncated)' : output;
    return `✅ Command output:\n$ ${command}\n\n${truncated}`;
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

    const output = execSync(cmd, { encoding: 'utf-8', timeout: 15000, shell: '/bin/zsh' }).trim();

    if (!output) return `🔍 No matches found for "${pattern}" in ${resolvedPath}`;

    const lines = output.split('\n');
    return `🔍 Found ${lines.length}${lines.length >= 50 ? '+' : ''} matches for "${pattern}":\n\n${output}`;
  } catch (err) {
    if (err.status === 1) return `🔍 No matches found for "${pattern}"`;
    return `❌ Search error: ${err.message}`;
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
};

module.exports = tools;
