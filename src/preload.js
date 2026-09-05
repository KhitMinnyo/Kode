'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kode', {
  /**
   * List all available Ollama models.
   * @returns {Promise<Array<{name: string, size: number, modified_at: string, details: object}>>}
   */
  listModels: () => ipcRenderer.invoke('list-models'),

  /**
   * Check if Ollama is connected and running.
   * @returns {Promise<{connected: boolean, error?: string}>}
   */
  checkConnection: () => ipcRenderer.invoke('check-connection'),

  /**
   * Send a message to the AI agent.
   * Streaming tokens and tool executions are delivered via event callbacks, each
   * tagged with the same `tabId` so the renderer can route them to the right tab
   * — see main.js's "Per-Tab Agent Registry" for why: each tab runs its own
   * AgentCore + LLM client instance, so multiple tabs can generate truly in
   * parallel without interfering with each other.
   * @param {string} tabId - Which tab this message belongs to (its own AgentCore
   *   instance is created lazily on first use). Pass a stable per-tab id.
   * @param {string} model - The model name
   * @param {string} message - The user message
   * @param {Array<{role: string, content: string}>} history - Conversation history
   * @param {string} [projectPath] - The tab's own active project folder (falls
   *   back to the legacy global active project if omitted)
   * @returns {Promise<{response: string, toolResults: Array}>}
   */
  sendMessage: (tabId, model, message, history, projectPath) => {
    return ipcRenderer.invoke('send-message', { tabId, model, message, history, projectPath });
  },

  /**
   * Stop the current generation for a specific tab. Other tabs keep generating.
   * @param {string} tabId
   * @returns {Promise<void>}
   */
  stopGeneration: (tabId) => ipcRenderer.invoke('stop-generation', tabId),

  /**
   * Close a tab: stops any in-flight generation for it and discards its
   * AgentCore + client instance on the main-process side.
   * @param {string} tabId
   * @returns {Promise<{success: boolean}>}
   */
  closeTab: (tabId) => ipcRenderer.invoke('close-tab', tabId),

  /**
   * Preload a model into Ollama's memory so the first real message responds faster.
   * Best-effort — safe to call speculatively whenever the selected model changes.
   * @param {string} model - The model name to warm up
   * @returns {Promise<{success: boolean}>}
   */
  warmModel: (model) => ipcRenderer.invoke('warm-model', model),

  /**
   * Register a callback for streaming text tokens. Every tab's tokens flow through
   * this same event, tagged with `tabId` — filter/route by `data.tabId` in the
   * renderer to keep multiple tabs' streams from mixing.
   * @param {function({tabId: string, token: string}): void} callback
   * @returns {function(): void} Cleanup function to remove the listener
   */
  onStreamToken: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('stream-token', handler);
    return () => ipcRenderer.removeListener('stream-token', handler);
  },

  /**
   * Register a callback for tool execution events.
   * @param {function({tabId: string, tool: string, params: object, result: string}): void} callback
   * @returns {function(): void} Cleanup function to remove the listener
   */
  onToolExecution: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('tool-execution', handler);
    return () => ipcRenderer.removeListener('tool-execution', handler);
  },

  /**
   * Register a callback for when streaming ends.
   * @param {function({tabId: string, response: string, toolResults: Array}): void} callback
   * @returns {function(): void} Cleanup function to remove the listener
   */
  onStreamEnd: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('stream-end', handler);
    return () => ipcRenderer.removeListener('stream-end', handler);
  },

  /**
   * Register a callback for stream errors.
   * @param {function({tabId: string, error: string}): void} callback
   * @returns {function(): void} Cleanup function to remove the listener
   */
  onStreamError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('stream-error', handler);
    return () => ipcRenderer.removeListener('stream-error', handler);
  },

  /** Register a callback for agent status updates. Payload includes `tabId`. */
  onAgentStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('agent-status', handler);
    return () => ipcRenderer.removeListener('agent-status', handler);
  },

  // ─── Chat History APIs ──────────────────────────────────────────────────

  /** Get all chats (metadata only). */
  getChats: (opts) => ipcRenderer.invoke('get-chats', opts || {}),

  /** Get a specific chat with full messages. */
  getChat: (chatId) => ipcRenderer.invoke('get-chat', chatId),

  /** Create a new chat. */
  createChat: ({ title, model, projectPath }) => ipcRenderer.invoke('create-chat', { title, model, projectPath }),

  /** Update a chat's title. */
  updateChatTitle: (chatId, title) => ipcRenderer.invoke('update-chat-title', { chatId, title }),

  /** Delete a chat. */
  deleteChat: (chatId) => ipcRenderer.invoke('delete-chat', chatId),

  /** Save chat messages and metadata. */
  saveChat: ({ chatId, messages, model, title }) => ipcRenderer.invoke('save-chat', { chatId, messages, model, title }),

  /** Set the active chat. */
  setActiveChat: (chatId) => ipcRenderer.invoke('set-active-chat', chatId),

  // ─── Multi-Project APIs ──────────────────────────────────────────────────

  /**
   * Open a native dialog to add a project folder.
   * @returns {Promise<{success: boolean, projects?: Array, activeIndex?: number}>}
   */
  addProject: () => ipcRenderer.invoke('add-project'),

  /**
   * Remove a project by its index.
   * @param {number} index
   * @returns {Promise<{success: boolean, projects?: Array, activeIndex?: number}>}
   */
  removeProject: (index) => ipcRenderer.invoke('remove-project', index),

  /**
   * Get all opened projects and active index.
   * @returns {Promise<{projects: Array<{path: string, name: string}>, activeIndex: number}>}
   */
  getProjects: () => ipcRenderer.invoke('get-projects'),

  /**
   * Set the active project by index.
   * @param {number} index
   * @returns {Promise<{success: boolean, activeIndex?: number}>}
   */
  setActiveProject: (index) => ipcRenderer.invoke('set-active-project', index),

  /**
   * List the file tree for a path (recursive, limited depth).
   * @param {string} rootPath - Root path to list
   * @param {number} [maxDepth=3] - Maximum depth to recurse
   * @returns {Promise<{success: boolean, tree?: Array, root?: string}>}
   */
  listFileTree: (rootPath, maxDepth) => ipcRenderer.invoke('list-file-tree', rootPath, maxDepth),

  // ─── Attachment APIs ─────────────────────────────────────────────────────────
  // "Attach file(s)" / "Attach folder" in the chat input, like Claude's own file
  // attachment UI — see main.js's "Attachment Handlers" section.

  /**
   * Open a native dialog to pick one or more files to attach to the next message.
   * @returns {Promise<{success: boolean, paths?: string[], canceled?: boolean}>}
   */
  pickAttachmentFiles: () => ipcRenderer.invoke('pick-attachment-files'),

  /**
   * Open a native dialog to pick a folder to attach to the next message.
   * @returns {Promise<{success: boolean, path?: string, canceled?: boolean}>}
   */
  pickAttachmentFolder: () => ipcRenderer.invoke('pick-attachment-folder'),

  /**
   * Read an attached file's content or a folder's file tree, formatted as text
   * ready to inject into a message.
   * @param {string} attachedPath
   * @returns {Promise<{success: boolean, type?: 'file'|'folder', content?: string, error?: string}>}
   */
  getAttachmentContent: (attachedPath) => ipcRenderer.invoke('get-attachment-content', attachedPath),

  // ─── Settings APIs ──────────────────────────────────────────────────────────

  /** Get current app settings. */
  getSettings: () => ipcRenderer.invoke('get-settings'),

  /** Save app settings. */
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  /** Test connection to a provider without saving. */
  testConnection: (params) => ipcRenderer.invoke('test-connection', params),

  /**
   * Get the app's version string (e.g. "1.1.1"), read from package.json.
   * @returns {Promise<string>}
   */
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  /**
   * Check GitHub Releases for a newer version than the one currently running.
   * @returns {Promise<{updateAvailable: boolean, currentVersion: string, latestVersion: string|null, releaseUrl: string}|{error: string}>}
   */
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),

  // ─── Persistent Memory APIs ──────────────────────────────────────────────

  /**
   * List saved long-term memory entries for the active project.
   * @returns {Promise<{success: boolean, entries?: Array, projectPath?: string, error?: string}>}
   */
  listMemory: () => ipcRenderer.invoke('list-memory'),

  /**
   * Delete a memory entry by key from the active project's memory store.
   * @param {string} key
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  deleteMemoryEntry: (key) => ipcRenderer.invoke('delete-memory', key),

  // ─── Background Process APIs ─────────────────────────────────────────────
  // Servers started by run_command (e.g. "npm start", "flask run") keep running
  // in the background. These APIs let the UI show their live logs and stop them.

  /** List background processes started via run_command, running or recently exited. */
  listProcesses: () => ipcRenderer.invoke('list-processes'),

  /** Get the full buffered log for a background process by PID. */
  getProcessLog: (pid) => ipcRenderer.invoke('get-process-log', pid),

  /** Stop a running background process by PID. */
  stopProcess: (pid) => ipcRenderer.invoke('stop-process', pid),

  /** Register a callback for new log chunks from a background process. */
  onProcessLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('process-log', handler);
    return () => ipcRenderer.removeListener('process-log', handler);
  },

  /** Register a callback for when a background process exits. */
  onProcessExit: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('process-exit', handler);
    return () => ipcRenderer.removeListener('process-exit', handler);
  },

  /** Register a callback for when a new background process starts. */
  onProcessStart: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('process-start', handler);
    return () => ipcRenderer.removeListener('process-start', handler);
  },

  // ─── Risky Command Confirmation ──────────────────────────────────────────
  // When Settings → Safety → "confirm risky commands" is on, run_command pauses on
  // its risky-but-allowed patterns (curl|sh, base64->sh, etc.) and asks here before
  // executing — see main.js's makeConfirmCommandCallback.

  /**
   * Register a callback for when the agent wants to run a risky command and needs
   * approval. Respond with respondConfirmCommand(requestId, approved).
   * @param {function({requestId: string, command: string, label: string, tabId: string}): void} callback
   * @returns {function(): void} Cleanup function to remove the listener
   */
  onConfirmCommandRequest: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('confirm-command-request', handler);
    return () => ipcRenderer.removeListener('confirm-command-request', handler);
  },

  /**
   * Answer a pending confirm-command-request.
   * @param {string} requestId
   * @param {boolean} approved
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  respondConfirmCommand: (requestId, approved) => ipcRenderer.invoke('confirm-command-response', { requestId, approved }),
});
