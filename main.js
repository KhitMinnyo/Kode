'use strict';

const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const OllamaClient = require('./src/ollama/client');
const DeepSeekClient = require('./src/deepseek/client');
const AgentCore = require('./src/agent/core');

// ─── Globals ─────────────────────────────────────────────────────────────────

let mainWindow = null;
let projects = [];         // Array of { path, name }
let activeProjectIndex = -1;

// ─── Settings ────────────────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(app.getPath('userData'), 'kode-settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return { ...getDefaultSettings(), ...JSON.parse(data) };
    }
  } catch (err) {
    console.error('Failed to load settings:', err.message);
  }
  return getDefaultSettings();
}

function getDefaultSettings() {
  return {
    provider: 'ollama',          // 'ollama' or 'deepseek'
    ollamaHost: 'localhost',     // Ollama server hostname/IP
    ollamaPort: 11434,           // Ollama server port
    deepseekApiKey: '',          // DeepSeek API key
  };
}

function saveSettings(newSettings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save settings:', err.message);
  }
}

function buildOllamaUrl(host, port) {
  return `http://${host || 'localhost'}:${port || 11434}`;
}

let appSettings = loadSettings();
let ollamaClient = new OllamaClient(buildOllamaUrl(appSettings.ollamaHost, appSettings.ollamaPort));
let deepseekClient = new DeepSeekClient(appSettings.deepseekApiKey || '');

// Active client depends on provider setting
function getActiveClient() {
  return appSettings.provider === 'deepseek' ? deepseekClient : ollamaClient;
}

const agentCore = new AgentCore(ollamaClient);

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
      sandbox: false,
    },
  });

  // Load the renderer HTML
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

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
        const activeFolder = activeProjectIndex >= 0 && projects[activeProjectIndex]
          ? projects[activeProjectIndex].path
          : null;

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
          }
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

    function buildTree(dirPath, depth) {
      if (depth > maxDepth) return [];
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        // Filter out hidden files/dirs and node_modules, .git, etc.
        const filtered = entries.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__' && e.name !== '.git');
        // Sort dirs first
        filtered.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });
        return filtered.map(entry => {
          const fullPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            return { name: entry.name, path: fullPath, type: 'directory', children: buildTree(fullPath, depth + 1) };
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

    return { success: true, tree: buildTree(rootPath, 0), root: rootPath };
  });

  // ─── Settings Handlers ──────────────────────────────────────────────────────

  /**
   * Get current settings
   */
  ipcMain.handle('get-settings', () => {
    return appSettings;
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

      // Reconfigure DeepSeek client with new API key
      deepseekClient.updateApiKey(appSettings.deepseekApiKey || '');

      // Update AgentCore's client reference based on provider
      agentCore.ollamaClient = getActiveClient();

      return { success: true, settings: appSettings };
    } catch (err) {
      console.error('[IPC:save-settings] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Test connection to a specific host (without saving)
   */
  ipcMain.handle('test-connection', async (event, { provider, ollamaHost, ollamaPort, deepseekApiKey }) => {
    try {
      if (provider === 'deepseek') {
        const testClient = new DeepSeekClient(deepseekApiKey || '');
        const status = await testClient.checkConnection();
        return status;
      } else {
        const testClient = new OllamaClient(buildOllamaUrl(ollamaHost, ollamaPort));
        const status = await testClient.checkConnection();
        return status;
      }
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
