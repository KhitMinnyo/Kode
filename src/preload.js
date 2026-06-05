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
   * Streaming tokens and tool executions are delivered via event callbacks.
   * @param {string} model - The model name
   * @param {string} message - The user message
   * @param {Array<{role: string, content: string}>} history - Conversation history
   * @returns {Promise<{response: string, toolResults: Array}>}
   */
  sendMessage: (model, message, history) => {
    return ipcRenderer.invoke('send-message', { model, message, history });
  },

  /**
   * Stop the current generation.
   * @returns {Promise<void>}
   */
  stopGeneration: () => ipcRenderer.invoke('stop-generation'),

  /**
   * Register a callback for streaming text tokens.
   * @param {function(Event, string): void} callback
   * @returns {function(): void} Cleanup function to remove the listener
   */
  onStreamToken: (callback) => {
    const handler = (_event, token) => callback(token);
    ipcRenderer.on('stream-token', handler);
    return () => ipcRenderer.removeListener('stream-token', handler);
  },

  /**
   * Register a callback for tool execution events.
   * @param {function(Event, {tool: string, params: object, result: string}): void} callback
   * @returns {function(): void} Cleanup function to remove the listener
   */
  onToolExecution: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('tool-execution', handler);
    return () => ipcRenderer.removeListener('tool-execution', handler);
  },

  /**
   * Register a callback for when streaming ends.
   * @param {function(Event, {response: string, toolResults: Array}): void} callback
   * @returns {function(): void} Cleanup function to remove the listener
   */
  onStreamEnd: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('stream-end', handler);
    return () => ipcRenderer.removeListener('stream-end', handler);
  },

  /**
   * Register a callback for stream errors.
   * @param {function(Event, {error: string}): void} callback
   * @returns {function(): void} Cleanup function to remove the listener
   */
  onStreamError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('stream-error', handler);
    return () => ipcRenderer.removeListener('stream-error', handler);
  },

  /** Register a callback for agent status updates. */
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

  // ─── Settings APIs ──────────────────────────────────────────────────────────

  /** Get current app settings. */
  getSettings: () => ipcRenderer.invoke('get-settings'),

  /** Save app settings. */
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  /** Test connection to a provider without saving. */
  testConnection: (params) => ipcRenderer.invoke('test-connection', params),
});
