'use strict';

const { app, BrowserWindow, ipcMain, dialog, nativeImage, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const OllamaClient = require('./src/ollama/client');
const DeepSeekClient = require('./src/deepseek/client');
const OpenAIClient = require('./src/openai/client');
const AnthropicClient = require('./src/anthropic/client');
const CustomClient = require('./src/custom/client');
const AgentCore = require('./src/agent/core');
const agentTools = require('./src/agent/tools'); // reused directly for reading file/folder attachments — see "Attachment Handlers" below

// OpenRouter (https://openrouter.ai) is just an OpenAI-compatible aggregator — it's
// wired up as a dedicated Settings tab (instead of making users configure the
// generic "Custom" provider by hand) purely because getting a key there is quick
// and it fronts a huge range of models. Under the hood it's the same CustomClient,
// just pre-pointed at OpenRouter's base URL so only an API key is needed.
// Where Kode itself is published — used only for the lightweight "update available"
// check below, not for anything user-configurable.
const GITHUB_REPO = 'KhitMinnyo/Kode';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// OpenRouter fronts models with wildly different context windows (8K to 2M+); this
// is a single reasonable guess used for history-budgeting when the exact model's
// real limit isn't otherwise known — same tradeoff OpenAIClient/AnthropicClient
// already make with their own fixed per-provider guesses.
const OPENROUTER_DEFAULT_CONTEXT_SIZE = 128000;
const memoryStore = require('./src/agent/memory');
const processManager = require('./src/agent/processManager');

// ─── Globals ─────────────────────────────────────────────────────────────────

let mainWindow = null;
let projects = [];         // Array of { path, name }
let activeProjectIndex = -1;

// Outstanding "please confirm this risky command" round-trips to the renderer, keyed
// by requestId. See the 'confirm-command-request'/'confirm-command-response' pair
// below and src/agent/tools.js's run_command.
const pendingCommandConfirmations = new Map(); // requestId -> resolve(approved: boolean)
let commandConfirmationCounter = 0;
const CONFIRM_COMMAND_TIMEOUT_MS = 2 * 60 * 1000; // fail safe (deny) if nobody answers

// ─── Settings ────────────────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(app.getPath('userData'), 'kode-settings.json');

// These hold API keys, so they're encrypted at rest via Electron's safeStorage
// (OS keychain on macOS, libsecret/kwallet on Linux, DPAPI on Windows) rather than
// written to disk as plaintext JSON.
const SECRET_FIELDS = ['deepseekApiKey', 'openaiApiKey', 'anthropicApiKey', 'openrouterApiKey', 'customApiKey'];

/**
 * Encrypts a secret for on-disk storage. Falls back to storing it in plaintext
 * (matching the app's previous behavior) if safeStorage's OS-level backend isn't
 * available — e.g. some minimal Linux setups without a keyring daemon — rather than
 * failing to save the key at all.
 */
function encryptSecret(value) {
  if (!value) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { __enc: true, data: safeStorage.encryptString(value).toString('base64') };
    }
    console.warn('[Settings] OS-level encryption is not available on this system — API key will be stored in plaintext.');
  } catch (err) {
    console.warn('[Settings] Encryption failed, storing key in plaintext:', err.message);
  }
  return value;
}

/** Reverses encryptSecret(); also transparently accepts old plaintext-format settings files. */
function decryptSecret(stored) {
  if (!stored) return '';
  if (typeof stored === 'string') return stored; // legacy plaintext, or the plaintext fallback above
  if (stored && stored.__enc && stored.data) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.data, 'base64'));
    } catch (err) {
      console.warn('[Settings] Failed to decrypt a stored API key (may need to be re-entered):', err.message);
      return '';
    }
  }
  return '';
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const onDisk = JSON.parse(data);
      const decrypted = { ...onDisk };
      for (const field of SECRET_FIELDS) {
        decrypted[field] = decryptSecret(onDisk[field]);
      }
      return { ...getDefaultSettings(), ...decrypted };
    }
  } catch (err) {
    console.error('Failed to load settings:', err.message);
  }
  return getDefaultSettings();
}

function getDefaultSettings() {
  return {
    provider: 'ollama',          // 'ollama' | 'deepseek' | 'openai' | 'anthropic' | 'openrouter' | 'custom'
    ollamaHost: 'localhost',     // Ollama server hostname/IP
    ollamaPort: 11434,           // Ollama server port
    deepseekApiKey: '',          // DeepSeek API key
    openaiApiKey: '',            // OpenAI (ChatGPT) API key
    anthropicApiKey: '',         // Anthropic (Claude) API key
    openrouterApiKey: '',        // OpenRouter API key (openrouter.ai) — base URL is fixed, see OPENROUTER_BASE_URL
    customApiKey: '',            // API key for the custom OpenAI-compatible provider (optional — many self-hosted servers don't need one)
    customBaseUrl: '',           // Base URL for the custom provider, e.g. https://api.groq.com/openai/v1
    customContextSize: 32768,    // Assumed context window for the custom provider — not auto-detectable, see src/custom/client.js
    maxContextTokens: 16384,     // Context-size ceiling; raise for large-context models (e.g. Qwen3.6)
    confirmRiskyCommands: true,  // Pause run_command's "risky but allowed" tier (curl|sh, base64->sh, etc.) for user approval — see src/agent/tools.js
  };
}

/**
 * Persists settings to disk with API keys encrypted. Takes a plain (all-string)
 * settings object and does NOT mutate it — callers keep holding plaintext keys in
 * memory (needed to pass to the client constructors / show in the Settings UI);
 * only the on-disk copy is transformed.
 */
function saveSettings(newSettings) {
  try {
    const toDisk = { ...newSettings };
    for (const field of SECRET_FIELDS) {
      toDisk[field] = encryptSecret(newSettings[field]);
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(toDisk, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save settings:', err.message);
  }
}

function buildOllamaUrl(host, port) {
  return `http://${host || 'localhost'}:${port || 11434}`;
}

/**
 * Compares two dotted version strings numerically, part by part (so "1.10.0" is
 * correctly greater than "1.9.0" — a plain string/lexicographic compare would get
 * that backwards). Missing parts count as 0, so "1.2" === "1.2.0".
 * @returns {number} 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareVersions(a, b) {
  const partsA = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const partsB = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

/**
 * Recursively builds a { name, path, type, children?/size? } tree for a directory,
 * depth-limited and skipping hidden files/node_modules/etc. Shared by the project
 * sidebar's 'list-file-tree' IPC handler and the "attach a folder" feature below
 * (get-attachment-content), so both present the exact same view of a folder.
 */
function buildFileTree(dirPath, depth, maxDepth) {
  if (depth > maxDepth) return [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const filtered = entries.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__' && e.name !== '.git');
    filtered.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    return filtered.map(entry => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return { name: entry.name, path: fullPath, type: 'directory', children: buildFileTree(fullPath, depth + 1, maxDepth) };
      }
      try {
        const stats = fs.statSync(fullPath);
        return { name: entry.name, path: fullPath, type: 'file', size: stats.size };
      } catch {
        return { name: entry.name, path: fullPath, type: 'file', size: 0 };
      }
    });
  } catch {
    return [];
  }
}

/** Renders a buildFileTree() result as an indented plain-text tree, for injecting a folder attachment's contents as text context for the model. */
function formatFileTreeAsText(tree, indent = '') {
  return tree.map((entry) => {
    if (entry.type === 'directory') {
      const childText = entry.children && entry.children.length > 0
        ? '\n' + formatFileTreeAsText(entry.children, indent + '  ')
        : '';
      return `${indent}📁 ${entry.name}/${childText}`;
    }
    const sizeLabel = entry.size < 1024 ? `${entry.size} B` : `${(entry.size / 1024).toFixed(1)} KB`;
    return `${indent}📄 ${entry.name} (${sizeLabel})`;
  }).join('\n');
}

let appSettings = loadSettings();
let ollamaClient = new OllamaClient(buildOllamaUrl(appSettings.ollamaHost, appSettings.ollamaPort));
let deepseekClient = new DeepSeekClient(appSettings.deepseekApiKey || '');
let openaiClient = new OpenAIClient(appSettings.openaiApiKey || '');
let anthropicClient = new AnthropicClient(appSettings.anthropicApiKey || '');
let openrouterClient = new CustomClient(appSettings.openrouterApiKey || '', OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_CONTEXT_SIZE);
let customClient = new CustomClient(appSettings.customApiKey || '', appSettings.customBaseUrl || '', appSettings.customContextSize || 32768);

// Active client depends on provider setting
function getActiveClient() {
  switch (appSettings.provider) {
    case 'deepseek': return deepseekClient;
    case 'openai': return openaiClient;
    case 'anthropic': return anthropicClient;
    case 'openrouter': return openrouterClient;
    case 'custom': return customClient;
    default: return ollamaClient;
  }
}

// Bind to whichever provider was actually selected at startup (getActiveClient()),
// not always the local Ollama client — otherwise, on relaunch with a cloud provider
// already selected in settings, the agent would keep talking to Ollama (mismatched
// against its own this.provider tag) until the user re-opened and re-saved Settings.
const agentCore = new AgentCore(getActiveClient(), appSettings.maxContextTokens, appSettings.provider);

// ─── Chat Storage ────────────────────────────────────────────────────────────
const CHATS_FILE = path.join(app.getPath('userData'), 'kode-chats.json');
let chats = [];        // Array of { id, title, model, messages, createdAt, updatedAt }
let activeChatId = null;

function loadChats() {
  try {
    if (fs.existsSync(CHATS_FILE)) {
      const data = fs.readFileSync(CHATS_FILE, 'utf-8');
      chats = JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to load chats:', err.message);
    chats = [];
  }
}

function saveChats() {
  try {
    fs.writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save chats:', err.message);
  }
}

// ─── Project Storage ─────────────────────────────────────────────────────────
const PROJECTS_FILE = path.join(app.getPath('userData'), 'kode-projects.json');

function loadProjects() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      const data = fs.readFileSync(PROJECTS_FILE, 'utf-8');
      const saved = JSON.parse(data);
      projects = saved.projects || [];
      activeProjectIndex = saved.activeIndex >= 0 ? saved.activeIndex : -1;
      // Validate that project folders still exist
      projects = projects.filter(p => {
        try { return fs.existsSync(p.path); } catch { return false; }
      });
      if (activeProjectIndex >= projects.length) {
        activeProjectIndex = projects.length > 0 ? 0 : -1;
      }
    }
  } catch (err) {
    console.error('Failed to load projects:', err.message);
    projects = [];
    activeProjectIndex = -1;
  }
}

function saveProjects() {
  try {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify({ projects, activeIndex: activeProjectIndex }, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save projects:', err.message);
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

/** Returns the currently active project's folder path, or null if none is active. */
function getActiveProjectFolder() {
  return activeProjectIndex >= 0 && projects[activeProjectIndex]
    ? projects[activeProjectIndex].path
    : null;
}

/**
 * Builds the onConfirmCommand callback threaded into AgentCore.processMessage for a
 * single send-message call, or null when the user has turned the safety toggle off
 * (in which case run_command's risky-but-allowed tier runs exactly as before —
 * auto-allowed with just a warning label).
 *
 * Sends a 'confirm-command-request' event to the renderer and waits for the matching
 * 'confirm-command-response' IPC call (see registerIPCHandlers below). If the window
 * is gone or nobody responds within CONFIRM_COMMAND_TIMEOUT_MS, fails safe by denying
 * the command rather than hanging the agent loop forever.
 */
function makeConfirmCommandCallback(sender) {
  if (!appSettings.confirmRiskyCommands) return null;

  return (command, label) => {
    if (sender.isDestroyed()) return Promise.resolve(false);

    const requestId = String(++commandConfirmationCounter);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingCommandConfirmations.delete(requestId);
        resolve(false);
      }, CONFIRM_COMMAND_TIMEOUT_MS);

      pendingCommandConfirmations.set(requestId, (approved) => {
        clearTimeout(timer);
        resolve(approved);
      });

      sender.send('confirm-command-request', { requestId, command, label });
    });
  };
}

// ─── Window Creation ─────────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin' ? true : undefined,
    backgroundColor: '#0a0a1a',
    icon: path.join(__dirname, 'icon.png'),
    show: false, // Show when ready to prevent visual flash
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron's OS-level renderer sandbox. Safe to enable here: preload.js only
      // touches contextBridge/ipcRenderer (both sandbox-compatible), and the renderer
      // itself never uses Node APIs directly — everything goes through the
      // window.kode bridge. See https://www.electronjs.org/docs/latest/tutorial/sandbox
      sandbox: true,
    },
  });

  // Load the renderer HTML
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  // Security: rendered assistant messages can contain links from arbitrary web
  // content (firecrawl_scrape/web_search results), and DOMPurify forces them to
  // target="_blank". Without these guards, Electron would either try to open a new
  // BrowserWindow pointed at attacker-controlled content, or (for a same-window
  // link) navigate the whole app away from index.html. Route link clicks to the
  // user's real browser instead, and block any other in-app navigation entirely.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (url.startsWith('https://') || url.startsWith('http://')) {
        shell.openExternal(url);
      }
    }
  });

  // Show window when content is ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────

function registerIPCHandlers() {
  /**
   * Background/server process visibility (see src/agent/processManager.js). Forward
   * live log chunks and exit events to the renderer so a "Processes" panel can show
   * a running dev server's output in real time instead of it vanishing once the
   * run_command tool call returns.
   */
  processManager.on('log', ({ pid, chunk }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process-log', { pid, chunk });
    }
  });
  processManager.on('exit', ({ pid, code }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process-exit', { pid, code });
    }
  });
  processManager.on('start', (entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process-start', entry);
    }
  });

  /**
   * List background processes (servers) started via run_command, running or recently exited.
   */
  ipcMain.handle('list-processes', async () => {
    return { success: true, processes: processManager.list() };
  });

  /**
   * Get the full buffered log for a background process by PID.
   */
  ipcMain.handle('get-process-log', async (event, pid) => {
    return { success: true, log: processManager.getLog(pid) };
  });

  /**
   * Stop a running background process (and its process group) by PID.
   */
  ipcMain.handle('stop-process', async (event, pid) => {
    const ok = processManager.stop(pid);
    return { success: ok };
  });

  /**
   * List available Ollama models
   */
  ipcMain.handle('list-models', async () => {
    try {
      const client = getActiveClient();
      const models = await client.listModels();
      return { success: true, models, provider: appSettings.provider };
    } catch (err) {
      console.error('[IPC:list-models] Error:', err.message);
      return { success: false, error: err.message, models: [], provider: appSettings.provider };
    }
  });

  /**
   * Check Ollama connection status
   */
  ipcMain.handle('check-connection', async () => {
    try {
      const client = getActiveClient();
      const status = await client.checkConnection();
      return { ...status, provider: appSettings.provider };
    } catch (err) {
      console.error('[IPC:check-connection] Error:', err.message);
      return { connected: false, error: err.message, provider: appSettings.provider };
    }
  });

  /**
   * List saved long-term memory entries for the active project.
   */
  ipcMain.handle('list-memory', async () => {
    const activeFolder = getActiveProjectFolder();
    if (!activeFolder) return { success: false, error: 'No active project', entries: [] };
    try {
      const data = memoryStore.loadMemory(activeFolder);
      return { success: true, entries: data.entries || [], projectPath: activeFolder };
    } catch (err) {
      console.error('[IPC:list-memory] Error:', err.message);
      return { success: false, error: err.message, entries: [] };
    }
  });

  /**
   * Delete a single memory entry by key from the active project's memory store.
   */
  ipcMain.handle('delete-memory', async (event, key) => {
    const activeFolder = getActiveProjectFolder();
    if (!activeFolder) return { success: false, error: 'No active project' };
    try {
      const ok = memoryStore.deleteMemoryEntry(activeFolder, key);
      return { success: ok };
    } catch (err) {
      console.error('[IPC:delete-memory] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Send a message to the agent with streaming support.
   * Streams tokens and tool executions back to the renderer via events.
   */
  ipcMain.handle('send-message', async (event, { model, message, history }) => {
    const sender = event.sender;

    // Deep-clone history to avoid mutation issues with IPC serialization
    const conversationHistory = Array.isArray(history)
      ? history.map((msg) => ({ role: msg.role, content: msg.content }))
      : [];

    try {
        // Get active project folder for tool execution
        const activeFolder = getActiveProjectFolder();

        const result = await agentCore.processMessage(
          message,
          model,
          conversationHistory,
          // onToken callback — stream each token to the renderer
          (token) => {
            if (!sender.isDestroyed()) {
              sender.send('stream-token', token);
            }
          },
          // onToolExecution callback — notify renderer of tool usage
          (toolExecution) => {
            if (!sender.isDestroyed()) {
              sender.send('tool-execution', {
                tool: toolExecution.tool,
                params: toolExecution.params,
                result: toolExecution.result,
              });
            }
          },
          activeFolder,
          // onStatus callback — forward agent status to renderer
          (statusUpdate) => {
            if (!sender.isDestroyed()) {
              sender.send('agent-status', statusUpdate);
            }
          },
          // onConfirmCommand callback — ask the renderer to approve/block a risky
          // run_command pattern before it executes (null/skipped when the user has
          // turned the Settings → Safety toggle off).
          makeConfirmCommandCallback(sender)
        );

      // Notify renderer that streaming is complete
      if (!sender.isDestroyed()) {
        sender.send('stream-end', {
          response: result.response,
          toolResults: result.toolResults,
        });
      }

      if (!sender.isDestroyed()) {
        sender.send('agent-status', { status: 'idle', message: '' });
      }

      return {
        success: true,
        response: result.response,
        toolResults: result.toolResults,
        history: conversationHistory,
      };
    } catch (err) {
      console.error('[IPC:send-message] Error:', err.message);

      // Map technical errors to user-friendly messages
      let userMessage = err.message;
      if (err.message === 'aborted' || err.message === 'Request aborted') {
        userMessage = '⏱️ Model took too long to respond. This can happen with large context. Try sending a shorter message or use a faster model.';
      } else if (err.message.includes('does not support chat')) {
        userMessage = '⚠️ This model does not support chat. Please select a different model (e.g., llama, deepseek, qwen).';
      } else if (err.message.includes('ECONNREFUSED')) {
        userMessage = '🔌 Cannot connect to Ollama. Please make sure Ollama is running.';
      }

      if (!sender.isDestroyed()) {
        sender.send('stream-error', { error: userMessage });
        sender.send('agent-status', { status: 'idle', message: '' });
      }

      return {
        success: false,
        error: err.message,
        history: conversationHistory,
      };
    }
  });

  /**
   * Preload (warm up) a model into Ollama's memory ahead of the first real message,
   * so the user doesn't pay full disk-load latency on their first prompt. Best-effort:
   * failures are non-fatal since generation will still trigger a load anyway.
   */
  ipcMain.handle('warm-model', async (event, model) => {
    try {
      if (appSettings.provider !== 'ollama' || !model) {
        return { success: false, skipped: true };
      }
      const ok = await ollamaClient.warmup(model);
      return { success: ok };
    } catch (err) {
      console.error('[IPC:warm-model] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Stop the current generation
   */
  ipcMain.handle('stop-generation', async () => {
    try {
      agentCore.stopGeneration();
      return { success: true };
    } catch (err) {
      console.error('[IPC:stop-generation] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Renderer's answer to a 'confirm-command-request' event (see
   * makeConfirmCommandCallback above) — resolves the matching pending Promise that
   * run_command is awaiting before it runs a risky-but-allowed command.
   */
  ipcMain.handle('confirm-command-response', (event, { requestId, approved }) => {
    const resolve = pendingCommandConfirmations.get(requestId);
    if (!resolve) return { success: false, error: 'No pending confirmation for this requestId (it may have already timed out).' };
    pendingCommandConfirmations.delete(requestId);
    resolve(!!approved);
    return { success: true };
  });

  // ─── Chat History Handlers ──────────────────────────────────────────────────

  /**
   * Get all chats (metadata only, no messages)
   */
  ipcMain.handle('get-chats', (event, { projectPath } = {}) => {
    let filtered = chats;
    if (projectPath) {
      filtered = chats.filter(c => c.projectPath === projectPath);
    }
    return {
      chats: filtered.map(c => ({
        id: c.id,
        title: c.title,
        model: c.model,
        projectPath: c.projectPath || null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messages ? c.messages.length : 0,
      })),
      activeChatId,
    };
  });

  /**
   * Get a specific chat with full messages
   */
  ipcMain.handle('get-chat', (event, chatId) => {
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return { success: false, error: 'Chat not found' };
    return { success: true, chat };
  });

  /**
   * Create a new chat
   */
  ipcMain.handle('create-chat', (event, { title, model, projectPath }) => {
    const chat = {
      id: generateId(),
      title: title || 'New Chat',
      model: model || '',
      projectPath: projectPath || null,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    chats.unshift(chat);  // Add to beginning
    activeChatId = chat.id;
    saveChats();
    return { success: true, chat: { id: chat.id, title: chat.title, model: chat.model, projectPath: chat.projectPath, createdAt: chat.createdAt, updatedAt: chat.updatedAt, messageCount: 0 } };
  });

  /**
   * Update chat title
   */
  ipcMain.handle('update-chat-title', (event, { chatId, title }) => {
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return { success: false, error: 'Chat not found' };
    chat.title = title;
    chat.updatedAt = Date.now();
    saveChats();
    return { success: true };
  });

  /**
   * Delete a chat
   */
  ipcMain.handle('delete-chat', (event, chatId) => {
    const idx = chats.findIndex(c => c.id === chatId);
    if (idx < 0) return { success: false, error: 'Chat not found' };
    chats.splice(idx, 1);
    if (activeChatId === chatId) {
      activeChatId = chats.length > 0 ? chats[0].id : null;
    }
    saveChats();
    return { success: true, activeChatId };
  });

  /**
   * Save/sync chat messages and metadata
   */
  ipcMain.handle('save-chat', (event, { chatId, messages, model, title }) => {
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return { success: false, error: 'Chat not found' };
    if (messages) chat.messages = messages;
    if (model) chat.model = model;
    if (title) chat.title = title;
    chat.updatedAt = Date.now();
    saveChats();
    return { success: true };
  });

  /**
   * Set active chat
   */
  ipcMain.handle('set-active-chat', (event, chatId) => {
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return { success: false, error: 'Chat not found' };
    activeChatId = chatId;
    return { success: true, chat };
  });

  // ─── Multi-Project Handlers ───────────────────────────────────────────────

  /**
   * Add a new project folder via native dialog
   */
  ipcMain.handle('add-project', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open Project Folder',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    const folderPath = result.filePaths[0];
    // Check if already added
    const existing = projects.findIndex(p => p.path === folderPath);
    if (existing >= 0) {
      activeProjectIndex = existing;
      saveProjects();
      return { success: true, projects, activeIndex: activeProjectIndex };
    }
    const name = path.basename(folderPath);
    projects.push({ path: folderPath, name });
    activeProjectIndex = projects.length - 1;
    saveProjects();
    return { success: true, projects, activeIndex: activeProjectIndex };
  });

  /**
   * Remove a project by index
   */
  ipcMain.handle('remove-project', (event, index) => {
    if (index < 0 || index >= projects.length) {
      return { success: false, error: 'Invalid index' };
    }
    projects.splice(index, 1);
    // Adjust active index
    if (projects.length === 0) {
      activeProjectIndex = -1;
    } else if (activeProjectIndex >= projects.length) {
      activeProjectIndex = projects.length - 1;
    } else if (activeProjectIndex > index) {
      activeProjectIndex--;
    } else if (activeProjectIndex === index) {
      activeProjectIndex = Math.min(index, projects.length - 1);
    }
    saveProjects();
    return { success: true, projects, activeIndex: activeProjectIndex };
  });

  /**
   * Get all projects and active index
   */
  ipcMain.handle('get-projects', () => {
    return { projects, activeIndex: activeProjectIndex };
  });

  /**
   * Set the active project by index
   */
  ipcMain.handle('set-active-project', (event, index) => {
    if (index < 0 || index >= projects.length) {
      return { success: false, error: 'Invalid index' };
    }
    activeProjectIndex = index;
    saveProjects();
    return { success: true, activeIndex: activeProjectIndex };
  });

  /**
   * List file tree for a given path (recursive, limited depth)
   */
  ipcMain.handle('list-file-tree', async (event, rootPath, maxDepth = 3) => {
    if (!rootPath) return { success: false, error: 'No path provided' };
    return { success: true, tree: buildFileTree(rootPath, 0, maxDepth), root: rootPath };
  });

  // ─── Attachment Handlers ────────────────────────────────────────────────────
  // "Attach file(s)" / "Attach folder" in the chat input (renderer: attach-file-btn /
  // attach-folder-btn) — like Claude's own file-attachment UI, but reading straight
  // off the local filesystem instead of an upload. The picked path(s) are read here
  // and the renderer injects the returned text into that turn's message before
  // sending — see setupAttachmentListeners()/sendMessage() in app.js.

  /**
   * Native multi-file picker for attachments.
   */
  ipcMain.handle('pick-attachment-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: 'Attach File(s)',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    return { success: true, paths: result.filePaths };
  });

  /**
   * Native folder picker for attachments.
   */
  ipcMain.handle('pick-attachment-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Attach Folder',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    return { success: true, path: result.filePaths[0] };
  });

  /**
   * Reads an attached path — a file's content (via agent/tools.js's own read_file,
   * so behavior — the 50KB cap, the "📄 path (size):" header — exactly matches what
   * the agent itself sees when it calls read_file) or, for a folder, a text file
   * tree (via buildFileTree/formatFileTreeAsText above, capped at depth 3 like the
   * project sidebar) — so the model gets an overview without every file's full
   * content being dumped in at once.
   */
  ipcMain.handle('get-attachment-content', async (event, attachedPath) => {
    if (!attachedPath) return { success: false, error: 'No path provided' };
    try {
      if (!fs.existsSync(attachedPath)) {
        return { success: false, error: 'File or folder not found' };
      }
      const stats = fs.statSync(attachedPath);
      if (stats.isDirectory()) {
        const tree = buildFileTree(attachedPath, 0, 3);
        const text = tree.length > 0 ? formatFileTreeAsText(tree) : '(empty folder)';
        return { success: true, type: 'folder', content: `[Attached folder: ${attachedPath}]\n${text}` };
      }
      const content = await agentTools.read_file({ path: attachedPath }, null);
      return { success: true, type: 'file', content: `[Attached file: ${attachedPath}]\n${content}` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Settings Handlers ──────────────────────────────────────────────────────

  /**
   * Get current settings
   */
  ipcMain.handle('get-settings', () => {
    return appSettings;
  });

  /**
   * Get the app's version (from package.json, via Electron's app.getVersion()).
   */
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  /**
   * Check GitHub Releases for a newer version than the one currently running, so the
   * UI can show a lightweight "update available" notice. This is a manual-download
   * pointer, not a real silent auto-update: Kode ships unsigned (see the README's
   * `xattr -cr` note), and macOS auto-update (electron-updater/Squirrel.Mac) requires
   * the app to be code-signed — without paying for an Apple Developer ID to sign and
   * notarize builds, an actual in-place auto-update wouldn't reliably work anyway.
   * Fails silently (returns { error }) on any network issue — this should never block
   * or nag the user, just quietly skip the notice.
   */
  ipcMain.handle('check-for-updates', () => {
    return new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_REPO}/releases/latest`,
        method: 'GET',
        headers: {
          'User-Agent': 'Kode-App-Update-Check',
          'Accept': 'application/vnd.github+json',
        },
        timeout: 8000,
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              resolve({ error: `GitHub returned HTTP ${res.statusCode}` });
              return;
            }
            const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            const latestVersion = String(data.tag_name || '').replace(/^v/i, '').trim();
            const currentVersion = app.getVersion();
            const updateAvailable = !!latestVersion && compareVersions(latestVersion, currentVersion) > 0;
            resolve({
              updateAvailable,
              currentVersion,
              latestVersion: latestVersion || null,
              releaseUrl: data.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`,
            });
          } catch (err) {
            resolve({ error: err.message });
          }
        });
      });

      req.on('error', (err) => resolve({ error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timed out' }); });
      req.end();
    });
  });

  /**
   * Save settings and reconfigure clients
   */
  ipcMain.handle('save-settings', async (event, newSettings) => {
    try {
      appSettings = { ...getDefaultSettings(), ...newSettings };
      saveSettings(appSettings);

      // Reconfigure Ollama client with new host
      ollamaClient.updateBaseUrl(buildOllamaUrl(appSettings.ollamaHost, appSettings.ollamaPort));

      // Reconfigure cloud clients with their (possibly new) API keys
      deepseekClient.updateApiKey(appSettings.deepseekApiKey || '');
      openaiClient.updateApiKey(appSettings.openaiApiKey || '');
      anthropicClient.updateApiKey(appSettings.anthropicApiKey || '');
      openrouterClient.updateApiKey(appSettings.openrouterApiKey || '');
      customClient.updateApiKey(appSettings.customApiKey || '');
      customClient.updateBaseUrl(appSettings.customBaseUrl || '');
      customClient.updateContextSize(appSettings.customContextSize || 32768);

      // Update AgentCore's client reference + provider tag based on the selected provider
      agentCore.ollamaClient = getActiveClient();
      agentCore.setProvider(appSettings.provider);

      // Apply the (possibly changed) context-size ceiling
      agentCore.setMaxContextCap(appSettings.maxContextTokens);

      return { success: true, settings: appSettings };
    } catch (err) {
      console.error('[IPC:save-settings] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Test connection to a specific host (without saving)
   */
  ipcMain.handle('test-connection', async (event, { provider, ollamaHost, ollamaPort, deepseekApiKey, openaiApiKey, anthropicApiKey, openrouterApiKey, customApiKey, customBaseUrl }) => {
    try {
      let testClient;
      switch (provider) {
        case 'deepseek': testClient = new DeepSeekClient(deepseekApiKey || ''); break;
        case 'openai': testClient = new OpenAIClient(openaiApiKey || ''); break;
        case 'anthropic': testClient = new AnthropicClient(anthropicApiKey || ''); break;
        case 'openrouter': testClient = new CustomClient(openrouterApiKey || '', OPENROUTER_BASE_URL); break;
        case 'custom': testClient = new CustomClient(customApiKey || '', customBaseUrl || ''); break;
        default: testClient = new OllamaClient(buildOllamaUrl(ollamaHost, ollamaPort));
      }
      return await testClient.checkConnection();
    } catch (err) {
      return { connected: false, error: err.message };
    }
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  loadChats();
  loadProjects();
  registerIPCHandlers();
  createMainWindow();

  // Set macOS dock icon
  if (process.platform === 'darwin') {
    const iconPath = path.join(__dirname, 'icon.png');
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    }
  }

  // macOS: re-create window when dock icon is clicked and no windows exist
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Graceful shutdown
app.on('before-quit', () => {
  agentCore.stopGeneration();
});
