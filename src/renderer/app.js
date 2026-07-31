/* ============================================================
   Kode — AI Agent  |  Main Application Controller
   ============================================================ */

(() => {
  'use strict';

  const { createMessageElement, createToolCard, createTypingIndicator,
          createWelcomeScreen, createModelOption, renderMarkdown,
          createFileTree } = window.KodeComponents;

  /* ==========================================================
     State
     ========================================================== */
  const state = {
    currentModel: null,
    conversationHistory: [],   // { role, content }
    isGenerating: false,
    currentAssistantMessage: '',
    currentAssistantEl: null,  // live DOM element during streaming
    toolResults: [],           // accumulates during a single response
    userHasScrolled: false,
    projects: [],              // Array of { path, name }
    activeProjectIndex: -1,
    activeChatId: null,
    chatList: [],              // Array of { id, title, model, createdAt, updatedAt, messageCount }
    _statusTimer: null,
    _statusStartTime: null,
    _tokenCount: 0,
  };

  /**
   * Basic debounce — delays invoking `fn` until `wait` ms have passed without
   * another call. Used to avoid firing a model-warmup request for every model the
   * user's mouse passes over while scrubbing through the dropdown.
   */
  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  const warmModelDebounced = debounce((model) => {
    window.kode.warmModel(model).catch(() => {});
  }, 500);

  // Model-name substrings known to support a much larger context window than Kode's
  // default 16K cap. This is a best-effort local heuristic (not queried from Ollama,
  // since num_ctx capability isn't reliably reported) — used only to surface a hint
  // pointing the user at Settings, never to change anything automatically.
  const KNOWN_LARGE_CONTEXT_MODELS = [
    { match: /qwen3\.6/i, tokens: 262144, label: '256K' },
    { match: /qwen2\.5|qwen3/i, tokens: 131072, label: '128K' },
    { match: /llama3\.1|llama3\.2|llama3\.3/i, tokens: 131072, label: '128K' },
    { match: /mistral-nemo/i, tokens: 131072, label: '128K' },
    { match: /command-r/i, tokens: 131072, label: '128K' },
  ];

  /**
   * Show a small, dismiss-by-navigating hint when the selected model is known to
   * support far more context than the current Settings cap — points the user at
   * Settings rather than silently changing anything on their behalf.
   */
  async function updateContextHint() {
    const hintEl = document.getElementById('context-hint');
    if (!hintEl) return;

    const known = state.currentModel && KNOWN_LARGE_CONTEXT_MODELS.find(k => k.match.test(state.currentModel));
    if (!known) {
      hintEl.hidden = true;
      return;
    }

    try {
      const settings = await window.kode.getSettings();
      const currentCap = settings.maxContextTokens || 16384;
      if (currentCap >= known.tokens) {
        hintEl.hidden = true;
        return;
      }
      hintEl.innerHTML = `💡 This model supports up to <strong>${known.label}</strong> context — Kode is capped at <strong>${currentCap.toLocaleString()}</strong>. Click to raise it in Settings.`;
      hintEl.hidden = false;
    } catch {
      hintEl.hidden = true;
    }
  }

  /* ==========================================================
     DOM References
     ========================================================== */
  const $ = (sel) => document.querySelector(sel);
  const messagesContainer = () => $('#messages-container');
  const modelSelect       = () => $('#model-select');
  const messageInput      = () => $('#message-input');
  const sendBtn           = () => $('#send-btn');
  const stopBtn           = () => $('#stop-btn');
  const statusDot         = () => $('#status-dot');
  const statusLabel       = () => $('#status-label');
  const chatTitle         = () => $('#chat-title');
  const newChatBtn        = () => $('#new-chat-btn');
  const openFolderBtn     = () => $('#open-folder-btn');

  /* ==========================================================
     Initialisation
     ========================================================== */
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    showWelcome();
    setupInputListeners();
    setupStreamListeners();
    setupSettingsListeners();
    await checkConnection();
    await loadModels();
    await loadProjectFolder();
    setupFolderListeners();
    await loadChatList();

    // Retry connection check every 5 seconds
    setInterval(checkConnection, 5000);
  }

  /* ==========================================================
     Connection
     ========================================================== */
  async function checkConnection() {
    try {
      const result = await window.kode.checkConnection();
      updateConnectionUI(result.connected, result.provider);
      return result.connected;
    } catch {
      updateConnectionUI(false);
      return false;
    }
  }

  function updateConnectionUI(connected, provider) {
    const dot = statusDot();
    const label = statusLabel();
    if (!dot || !label) return;

    const providerLabel = provider === 'deepseek' ? 'DeepSeek' : 'Ollama';

    if (connected) {
      dot.classList.add('connected');
      label.textContent = `${providerLabel} Connected`;
    } else {
      dot.classList.remove('connected');
      label.textContent = `${providerLabel} Disconnected`;
    }
  }

  /* ==========================================================
     Models
     ========================================================== */
  async function loadModels() {
    const select = modelSelect();
    if (!select) return;

    try {
      const result = await window.kode.listModels();
      let models = result?.models || result || [];
      select.innerHTML = '';

      // Filter out embedding models that don't support chat
      const embedPatterns = ['embed', 'nomic-embed', 'all-minilm', 'bge-', 'e5-', 'gte-'];
      models = models.filter(m => {
        const name = m.name.toLowerCase();
        return !embedPatterns.some(p => name.includes(p));
      });

      if (!models || models.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = 'No models found';
        opt.disabled = true;
        select.appendChild(opt);
        return;
      }

      models.forEach((m) => {
        select.appendChild(createModelOption(m));
      });

      state.currentModel = models[0].name;
      updateChatTitle();
      updateContextHint();

      // Speculatively warm the default model so the first message doesn't pay
      // full disk-load latency. Fire-and-forget — failures are non-fatal.
      window.kode.warmModel(state.currentModel).catch(() => {});
    } catch (err) {
      console.error('Failed to load models:', err);
      const opt = document.createElement('option');
      opt.textContent = 'Error loading models';
      opt.disabled = true;
      select.innerHTML = '';
      select.appendChild(opt);
    }
  }

  function updateChatTitle() {
    const el = chatTitle();
    if (!el) return;
    if (!state.currentModel) {
      el.innerHTML = 'No model selected';
      return;
    }
    const modelLower = state.currentModel.toLowerCase();
    const isSecModel = ['deephat', 'dolphin', 'uncensored', 'abliterated', 'evil'].some(k => modelLower.includes(k));
    const badge = isSecModel
      ? ' <span style="background:linear-gradient(135deg,#ff4444,#cc0000);color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;margin-left:8px;">🔓 Red Team</span>'
      : '';
    el.innerHTML = `Model: <strong>${state.currentModel}</strong>${badge}`;
  }

  /* ==========================================================
     Welcome Screen
     ========================================================== */
  function showWelcome() {
    const container = messagesContainer();
    if (!container) return;
    container.innerHTML = '';
    const welcome = createWelcomeScreen();
    container.appendChild(welcome);

    // Attach prompt-card click handlers
    welcome.querySelectorAll('.prompt-card').forEach((card) => {
      card.addEventListener('click', () => {
        const prompt = card.dataset.prompt;
        if (prompt) {
          const input = messageInput();
          if (input) input.value = prompt;
          sendMessage();
        }
      });
    });
  }

  function removeWelcome() {
    const el = $('#welcome-screen');
    if (el) el.remove();
  }

  /* ==========================================================
     Input Handling
     ========================================================== */
  function setupInputListeners() {
    // Send button
    const btn = sendBtn();
    if (btn) btn.addEventListener('click', sendMessage);

    // Stop button
    const stop = stopBtn();
    if (stop) stop.addEventListener('click', stopGeneration);

    // Textarea: Enter to send, Shift+Enter for newline, auto-resize
    const input = messageInput();
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
      input.addEventListener('input', autoResize);
    }

    // New chat
    const nc = newChatBtn();
    if (nc) nc.addEventListener('click', newChat);

    // Context-window hint — click to jump straight to Settings
    const contextHint = document.getElementById('context-hint');
    if (contextHint) contextHint.addEventListener('click', openSettings);

    // Model change
    const ms = modelSelect();
    if (ms) {
      ms.addEventListener('change', (e) => {
        state.currentModel = e.target.value;
        updateChatTitle();
        // Warm the newly selected model in the background so it's ready by the time
        // the user actually sends a message. Debounced so quickly scrubbing through
        // several models in the dropdown doesn't fire a warmup for each one — only
        // the one the user actually settles on.
        warmModelDebounced(state.currentModel);
        updateContextHint();
      });
    }

    // Scroll tracking — detect if user scrolled up
    const mc = messagesContainer();
    if (mc) {
      mc.addEventListener('scroll', () => {
        const { scrollTop, scrollHeight, clientHeight } = mc;
        state.userHasScrolled = (scrollHeight - scrollTop - clientHeight) > 60;
      });
    }
  }

  function autoResize() {
    const input = messageInput();
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  /* ==========================================================
     Send Message
     ========================================================== */
  async function sendMessage() {
    const input = messageInput();
    if (!input) return;

    const text = input.value.trim();
    if (!text || state.isGenerating) return;
    if (!state.currentModel) {
      appendError('Please select a model first.');
      return;
    }

    // Clear input & reset height
    input.value = '';
    input.style.height = 'auto';

    // Remove welcome if present
    removeWelcome();

    // Append user message
    const container = messagesContainer();
    const userMsg = createMessageElement('user', text);
    container.appendChild(userMsg);
    scrollToBottom();

    // Add to history
    state.conversationHistory.push({ role: 'user', content: text });

    // Auto-create chat if none active
    if (!state.activeChatId) {
      await createNewChat(text.substring(0, 40).trim() || 'New Chat');
    }
    // Auto-title if this is the first user message
    if (state.conversationHistory.filter(m => m.role === 'user').length === 1 && state.activeChatId) {
      const autoTitle = text.substring(0, 40).trim() + (text.length > 40 ? '…' : '');
      await window.kode.updateChatTitle(state.activeChatId, autoTitle);
      await loadChatList();
    }

    // Prepare assistant streaming state
    state.isGenerating = true;
    state.currentAssistantMessage = '';
    state.toolResults = [];
    setGeneratingUI(true);

    // Show typing indicator
    const typingEl = createTypingIndicator();
    container.appendChild(typingEl);
    scrollToBottom();

    // Send to backend
    try {
      await window.kode.sendMessage(
        state.currentModel,
        text,
        state.conversationHistory.slice(0, -1), // history excludes the new message (already sent as 'message' param)
      );
    } catch (err) {
      removeTypingIndicator();
      setGeneratingUI(false);
      state.isGenerating = false;
      appendError(`Failed to send message: ${err.message || err}`);
    }
  }

  /* ==========================================================
     Stream Listeners
     ========================================================== */
  function setupStreamListeners() {
    window.kode.onStreamToken((token) => {
      removeTypingIndicator();

      state.currentAssistantMessage += token;
      state._tokenCount++;
      updateTokenCounter();

      // Create or update the assistant message element
      if (!state.currentAssistantEl) {
        state.currentAssistantEl = createStreamingAssistantElement();
        messagesContainer().appendChild(state.currentAssistantEl);
      }

      updateStreamingContent();
      if (!state.userHasScrolled) scrollToBottom();
    });

    window.kode.onToolExecution((toolExec) => {
      removeTypingIndicator();

      state.toolResults.push(toolExec);

      // Ensure assistant element exists
      if (!state.currentAssistantEl) {
        state.currentAssistantEl = createStreamingAssistantElement();
        messagesContainer().appendChild(state.currentAssistantEl);
      }

      // Append tool card
      const bubble = state.currentAssistantEl.querySelector('.message-bubble');
      if (bubble) {
        bubble.appendChild(createToolCard(toolExec));
      }

      if (!state.userHasScrolled) scrollToBottom();
    });

    window.kode.onStreamEnd((data) => {
      clearAgentStatus();
      removeTypingIndicator();

      // Final content from response (may differ from accumulated tokens)
      const finalContent = data?.response || state.currentAssistantMessage;

      // Final render with full markdown + highlighting
      if (state.currentAssistantEl) {
        const bubble = state.currentAssistantEl.querySelector('.message-bubble');
        if (bubble) {
          // Preserve tool cards
          const toolCards = bubble.querySelectorAll('.tool-card');

          // Re-render markdown
          const md = renderMarkdown(finalContent);
          bubble.innerHTML = '';
          bubble.appendChild(md);

          // Re-attach tool cards
          toolCards.forEach((tc) => bubble.appendChild(tc));

          // Append any new tool results from the end payload
          if (data?.toolResults?.length) {
            data.toolResults.forEach((tr) => {
              // Avoid duplicates
              if (!state.toolResults.find(e => e.tool === tr.tool && JSON.stringify(e.params) === JSON.stringify(tr.params))) {
                bubble.appendChild(createToolCard(tr));
              }
            });
          }
        }
      }

      // Add to conversation history
      state.conversationHistory.push({ role: 'assistant', content: finalContent });

      // Auto-save chat
      if (state.activeChatId) {
        window.kode.saveChat({
          chatId: state.activeChatId,
          messages: state.conversationHistory,
          model: state.currentModel,
        });
      }

      // Reset streaming state
      state.currentAssistantEl = null;
      state.currentAssistantMessage = '';
      state.toolResults = [];
      state.isGenerating = false;
      setGeneratingUI(false);

      if (!state.userHasScrolled) scrollToBottom();
    });

    window.kode.onStreamError((error) => {
      clearAgentStatus();
      removeTypingIndicator();

      // Remove the in-progress assistant element if empty
      if (state.currentAssistantEl && !state.currentAssistantMessage) {
        state.currentAssistantEl.remove();
      }

      state.currentAssistantEl = null;
      state.currentAssistantMessage = '';
      state.toolResults = [];
      state.isGenerating = false;
      setGeneratingUI(false);

      const msg = typeof error === 'string' ? error : (error?.error || error?.message || 'An unexpected error occurred');
      appendError(msg);
    });

    // Agent status updates
    window.kode.onAgentStatus((data) => {
      updateAgentStatus(data.status, data.message);
    });
  }

  /* ==========================================================
     Streaming Helpers
     ========================================================== */
  function createStreamingAssistantElement() {
    const msg = document.createElement('div');
    msg.className = 'message assistant';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    msg.appendChild(bubble);

    return msg;
  }

  function updateStreamingContent() {
    if (!state.currentAssistantEl) return;
    const bubble = state.currentAssistantEl.querySelector('.message-bubble');
    if (!bubble) return;

    // Preserve existing tool cards
    const toolCards = bubble.querySelectorAll('.tool-card');

    // Re-render markdown from accumulated text
    const md = renderMarkdown(state.currentAssistantMessage);
    bubble.innerHTML = '';
    bubble.appendChild(md);

    // Re-attach tool cards
    toolCards.forEach((tc) => bubble.appendChild(tc));
  }

  /* ==========================================================
     UI Helpers
     ========================================================== */
  function setGeneratingUI(generating) {
    const send = sendBtn();
    const stop = stopBtn();
    const input = messageInput();

    if (send)  send.disabled = generating;
    if (send)  send.style.display = generating ? 'none' : 'flex';
    if (stop)  stop.classList.toggle('visible', generating);
    if (input) input.disabled = generating;
  }

  function removeTypingIndicator() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
  }

  function appendError(text) {
    const container = messagesContainer();
    if (!container) return;
    const msg = createMessageElement('error', `⚠️ ${text}`);
    container.appendChild(msg);
    scrollToBottom();
  }

  function scrollToBottom() {
    const mc = messagesContainer();
    if (!mc) return;
    requestAnimationFrame(() => {
      mc.scrollTop = mc.scrollHeight;
    });
  }

  function stopGeneration() {
    if (window.kode.stopGeneration) {
      window.kode.stopGeneration();
    }
    state.isGenerating = false;
    setGeneratingUI(false);
    removeTypingIndicator();
  }

  async function newChat() {
    state.conversationHistory = [];
    state.currentAssistantMessage = '';
    state.currentAssistantEl = null;
    state.toolResults = [];
    state.isGenerating = false;
    state.userHasScrolled = false;
    state.activeChatId = null;
    setGeneratingUI(false);
    showWelcome();
    // Deselect active chat in list
    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
  }

  /* ==========================================================
     Multi-Project Management
     ========================================================== */
  function setupFolderListeners() {
    const btn = openFolderBtn();
    if (btn) btn.addEventListener('click', addProject);
  }

  async function addProject() {
    try {
      const result = await window.kode.addProject();
      if (result.success) {
        state.projects = result.projects;
        state.activeProjectIndex = result.activeIndex;
        renderProjectsList();
        // Auto-expand the newly added project
        const items = document.querySelectorAll('.project-item');
        const lastItem = items[result.activeIndex];
        if (lastItem && !lastItem.classList.contains('expanded')) {
          lastItem.classList.add('expanded');
          loadProjectTree(result.activeIndex);
        }
      }
    } catch (err) {
      console.error('Failed to add project:', err);
    }
  }

  async function removeProject(index) {
    try {
      const result = await window.kode.removeProject(index);
      if (result.success) {
        state.projects = result.projects;
        state.activeProjectIndex = result.activeIndex;
        renderProjectsList();
      }
    } catch (err) {
      console.error('Failed to remove project:', err);
    }
  }

  async function setActiveProject(index) {
    try {
      const result = await window.kode.setActiveProject(index);
      if (result.success) {
        state.activeProjectIndex = result.activeIndex;
        // Update active class on all project items
        document.querySelectorAll('.project-item').forEach((el, i) => {
          el.classList.toggle('active', i === state.activeProjectIndex);
        });
        await loadChatList();
      }
    } catch (err) {
      console.error('Failed to set active project:', err);
    }
  }

  async function loadProjectFolder() {
    try {
      const result = await window.kode.getProjects();
      if (result.projects && result.projects.length > 0) {
        state.projects = result.projects;
        state.activeProjectIndex = result.activeIndex;
        renderProjectsList();
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
  }

  function renderProjectsList() {
    const listEl = document.getElementById('projects-list');
    const emptyEl = document.getElementById('projects-empty');
    if (!listEl) return;

    // Clear existing project items (keep empty placeholder)
    listEl.querySelectorAll('.project-item').forEach(el => el.remove());

    if (state.projects.length === 0) {
      if (emptyEl) emptyEl.style.display = 'flex';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    state.projects.forEach((project, index) => {
      const item = document.createElement('div');
      item.className = 'project-item' + (index === state.activeProjectIndex ? ' active' : '');
      item.dataset.index = index;

      // Header
      const header = document.createElement('div');
      header.className = 'project-item-header';

      const chevron = document.createElement('span');
      chevron.className = 'project-chevron';
      chevron.textContent = '▶';

      const icon = document.createElement('span');
      icon.className = 'project-icon';
      icon.textContent = '📁';

      const name = document.createElement('span');
      name.className = 'project-name';
      name.textContent = project.name;
      name.title = project.path;

      const activeDot = document.createElement('span');
      activeDot.className = 'project-active-dot';

      const closeBtn = document.createElement('button');
      closeBtn.className = 'project-close-btn';
      closeBtn.textContent = '✕';
      closeBtn.title = 'Remove project';

      header.append(chevron, icon, name, activeDot, closeBtn);

      // File tree container
      const treeContainer = document.createElement('div');
      treeContainer.className = 'project-tree';
      treeContainer.id = `project-tree-${index}`;

      item.append(header, treeContainer);

      // Click header = set active + toggle expand
      header.addEventListener('click', (e) => {
        if (e.target === closeBtn) return;
        setActiveProject(index);
        item.classList.toggle('expanded');
        icon.textContent = item.classList.contains('expanded') ? '📂' : '📁';
        if (item.classList.contains('expanded') && treeContainer.children.length === 0) {
          loadProjectTree(index);
        }
      });

      // Close button
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeProject(index);
      });

      listEl.appendChild(item);
    });
  }

  async function loadProjectTree(index) {
    const project = state.projects[index];
    if (!project) return;

    const container = document.getElementById(`project-tree-${index}`);
    if (!container) return;

    container.innerHTML = '<div style="padding:8px;font-size:0.7rem;color:var(--text-muted)">Loading...</div>';

    try {
      const result = await window.kode.listFileTree(project.path, 3);
      container.innerHTML = '';

      if (result.success && result.tree && result.tree.length > 0) {
        const tree = createFileTree(result.tree, handleFileClick);
        container.appendChild(tree);
      } else {
        container.innerHTML = '<div style="padding:8px;font-size:0.7rem;color:var(--text-muted)">Empty folder</div>';
      }
    } catch (err) {
      container.innerHTML = '<div style="padding:8px;font-size:0.7rem;color:var(--text-muted)">Failed to load</div>';
      console.error('File tree error:', err);
    }

    // Also render chats for this project
    if (index === state.activeProjectIndex) {
      await loadChatList();
    }
  }

  function handleFileClick(filePath, fileName) {
    const input = messageInput();
    if (input) {
      input.value = `Read the file: ${filePath}`;
      input.focus();
    }
  }

  /* ==========================================================
     Agent Activity Status
     ========================================================== */
  function updateAgentStatus(status, message) {
    const bar = document.getElementById('agent-status-bar');
    const indicator = document.getElementById('status-indicator');
    const text = document.getElementById('status-text');

    if (!bar || !indicator || !text) return;

    if (status === 'idle') {
      clearAgentStatus();
      return;
    }

    bar.classList.add('active');
    indicator.className = 'status-indicator ' + status;
    text.textContent = message;

    // Start elapsed timer if not started
    if (!state._statusStartTime) {
      state._statusStartTime = Date.now();
      state._tokenCount = 0;
      startElapsedTimer();
    }
  }

  function clearAgentStatus() {
    const bar = document.getElementById('agent-status-bar');
    if (bar) bar.classList.remove('active');

    if (state._statusTimer) {
      clearInterval(state._statusTimer);
      state._statusTimer = null;
    }
    state._statusStartTime = null;
    state._tokenCount = 0;
  }

  function startElapsedTimer() {
    if (state._statusTimer) clearInterval(state._statusTimer);
    const timerEl = document.getElementById('elapsed-timer');

    state._statusTimer = setInterval(() => {
      if (!state._statusStartTime || !timerEl) return;
      const elapsed = Math.floor((Date.now() - state._statusStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      timerEl.textContent = mins > 0
        ? `${mins}:${secs.toString().padStart(2, '0')}`
        : `${secs}s`;
    }, 1000);
  }

  function updateTokenCounter() {
    const el = document.getElementById('token-counter');
    if (el && state._tokenCount > 0) {
      el.textContent = `${state._tokenCount} tokens`;
    }
  }

  /* ==========================================================
     Chat History Management
     ========================================================== */
  async function loadChatList() {
    try {
      // Load all chats (no project filter — show everything)
      const result = await window.kode.getChats({});
      state.chatList = result.chats || [];
      if (result.activeChatId && !state.activeChatId) {
        state.activeChatId = result.activeChatId;
      }
      renderChatList();
    } catch (err) {
      console.error('Failed to load chats:', err);
    }
  }

  function renderChatList() {
    // 1) Clear old chat items from everywhere
    const generalContainer = document.getElementById('chat-list-container');
    if (generalContainer) generalContainer.innerHTML = '';
    document.querySelectorAll('.project-chat-list').forEach(el => el.remove());

    if (state.chatList.length === 0) return;

    // 2) Split chats: project-linked vs standalone
    const projectChats = {};  // projectPath → [chat, ...]
    const standaloneChats = [];

    state.chatList.forEach(chat => {
      if (chat.projectPath) {
        if (!projectChats[chat.projectPath]) projectChats[chat.projectPath] = [];
        projectChats[chat.projectPath].push(chat);
      } else {
        standaloneChats.push(chat);
      }
    });

    // 3) Render project chats inside each project tree
    state.projects.forEach((project, index) => {
      const chats = projectChats[project.path];
      if (!chats || chats.length === 0) return;

      const projectTree = document.getElementById(`project-tree-${index}`);
      if (!projectTree) return;

      const chatListEl = document.createElement('div');
      chatListEl.className = 'project-chat-list';

      chats.forEach(chat => {
        chatListEl.appendChild(createChatItem(chat));
      });

      projectTree.appendChild(chatListEl);
    });

    // 4) Render standalone chats in the Chats section
    if (generalContainer && standaloneChats.length > 0) {
      standaloneChats.forEach(chat => {
        generalContainer.appendChild(createChatItem(chat));
      });
    }
  }

  /**
   * Creates a single chat item DOM element (shared by project + standalone lists).
   */
  function createChatItem(chat) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === state.activeChatId ? ' active' : '');
    item.dataset.chatId = chat.id;

    const icon = document.createElement('span');
    icon.className = 'chat-item-icon';
    icon.textContent = '💬';

    const content = document.createElement('div');
    content.className = 'chat-item-content';

    const title = document.createElement('div');
    title.className = 'chat-item-title';
    title.textContent = chat.title || 'New Chat';

    const meta = document.createElement('div');
    meta.className = 'chat-item-meta';
    meta.textContent = formatTimeAgo(chat.updatedAt);

    content.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'chat-item-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'chat-action-btn';
    renameBtn.textContent = '✏️';
    renameBtn.title = 'Rename';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'chat-action-btn delete';
    deleteBtn.textContent = '🗑';
    deleteBtn.title = 'Delete';

    actions.append(renameBtn, deleteBtn);
    item.append(icon, content, actions);

    item.addEventListener('click', (e) => {
      if (e.target === renameBtn || e.target === deleteBtn) return;
      switchChat(chat.id);
    });

    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startRenameChat(chat.id, title);
    });

    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(chat.id);
    });

    return item;
  }

  async function createNewChat(title) {
    try {
      const activeProject = state.projects[state.activeProjectIndex];
      const projectPath = activeProject ? activeProject.path : null;
      const result = await window.kode.createChat({
        title: title || 'New Chat',
        model: state.currentModel || '',
        projectPath,
      });
      if (result.success) {
        state.activeChatId = result.chat.id;
        await loadChatList();
      }
    } catch (err) {
      console.error('Failed to create chat:', err);
    }
  }

  async function switchChat(chatId) {
    if (chatId === state.activeChatId) return;

    // Save current chat before switching
    if (state.activeChatId && state.conversationHistory.length > 0) {
      await window.kode.saveChat({
        chatId: state.activeChatId,
        messages: state.conversationHistory,
        model: state.currentModel,
      });
    }

    try {
      const result = await window.kode.setActiveChat(chatId);
      if (result.success && result.chat) {
        state.activeChatId = result.chat.id;
        state.conversationHistory = result.chat.messages || [];
        state.currentAssistantMessage = '';
        state.currentAssistantEl = null;
        state.toolResults = [];
        state.isGenerating = false;
        setGeneratingUI(false);

        // Restore chat messages in UI
        const container = messagesContainer();
        if (!container) return;
        container.innerHTML = '';

        if (state.conversationHistory.length === 0) {
          showWelcome();
        } else {
          state.conversationHistory.forEach(msg => {
            const el = createMessageElement(msg.role, msg.role === 'assistant' ? '' : msg.content);
            if (msg.role === 'assistant') {
              const bubble = el.querySelector('.message-bubble');
              if (bubble) {
                const md = renderMarkdown(msg.content);
                bubble.innerHTML = '';
                bubble.appendChild(md);
              }
            }
            container.appendChild(el);
          });
          scrollToBottom();
        }

        // Update active in list
        document.querySelectorAll('.chat-item').forEach(el => {
          el.classList.toggle('active', el.dataset.chatId === chatId);
        });

        // Set model if chat had one
        if (result.chat.model) {
          const select = modelSelect();
          if (select && select.querySelector(`option[value="${result.chat.model}"]`)) {
            select.value = result.chat.model;
            state.currentModel = result.chat.model;
            updateChatTitle();
          }
        }
      }
    } catch (err) {
      console.error('Failed to switch chat:', err);
    }
  }

  async function deleteChat(chatId) {
    try {
      const result = await window.kode.deleteChat(chatId);
      if (result.success) {
        if (state.activeChatId === chatId) {
          state.activeChatId = result.activeChatId || null;
          if (state.activeChatId) {
            await switchChat(state.activeChatId);
          } else {
            state.conversationHistory = [];
            showWelcome();
          }
        }
        await loadChatList();
      }
    } catch (err) {
      console.error('Failed to delete chat:', err);
    }
  }

  function startRenameChat(chatId, titleEl) {
    const currentText = titleEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chat-item-title-input';
    input.value = currentText;

    titleEl.textContent = '';
    titleEl.appendChild(input);
    input.focus();
    input.select();

    const finishRename = async () => {
      const newTitle = input.value.trim() || currentText;
      titleEl.textContent = newTitle;
      if (newTitle !== currentText) {
        await window.kode.updateChatTitle(chatId, newTitle);
        await loadChatList();
      }
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentText; input.blur(); }
    });
  }

  function formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  /* ==========================================================
     Settings Modal
     ========================================================== */
  function setupSettingsListeners() {
    const settingsBtn = document.getElementById('settings-btn');
    const overlay = document.getElementById('settings-overlay');
    const closeBtn = document.getElementById('settings-close-btn');
    const cancelBtn = document.getElementById('settings-cancel-btn');
    const saveBtn = document.getElementById('settings-save-btn');

    // Open
    if (settingsBtn) settingsBtn.addEventListener('click', openSettings);

    // Close
    if (closeBtn) closeBtn.addEventListener('click', closeSettings);
    if (cancelBtn) cancelBtn.addEventListener('click', closeSettings);

    // Close on overlay click (not modal itself)
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeSettings();
      });
    }

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay && overlay.classList.contains('active')) {
        closeSettings();
      }
    });

    // Save
    if (saveBtn) saveBtn.addEventListener('click', saveSettingsHandler);

    // Provider tabs
    const tabOllama = document.getElementById('tab-ollama');
    const tabDeepseek = document.getElementById('tab-deepseek');

    if (tabOllama) tabOllama.addEventListener('click', () => switchProviderTab('ollama'));
    if (tabDeepseek) tabDeepseek.addEventListener('click', () => switchProviderTab('deepseek'));

    // Test buttons
    const testOllama = document.getElementById('test-ollama-btn');
    const testDeepseek = document.getElementById('test-deepseek-btn');

    if (testOllama) testOllama.addEventListener('click', testOllamaConnection);
    if (testDeepseek) testDeepseek.addEventListener('click', testDeepseekConnection);

    // API key visibility toggle
    const toggleVis = document.getElementById('toggle-key-vis');
    if (toggleVis) {
      toggleVis.addEventListener('click', () => {
        const input = document.getElementById('deepseek-key');
        if (!input) return;
        if (input.type === 'password') {
          input.type = 'text';
          toggleVis.textContent = '🙈';
        } else {
          input.type = 'password';
          toggleVis.textContent = '👁';
        }
      });
    }
  }

  async function openSettings() {
    const overlay = document.getElementById('settings-overlay');
    if (!overlay) return;

    // Load current settings
    try {
      const settings = await window.kode.getSettings();
      const hostInput = document.getElementById('ollama-host');
      const portInput = document.getElementById('ollama-port');
      const keyInput = document.getElementById('deepseek-key');
      const contextInput = document.getElementById('max-context-tokens');

      if (hostInput) hostInput.value = settings.ollamaHost || 'localhost';
      if (portInput) portInput.value = settings.ollamaPort || 11434;
      if (keyInput) keyInput.value = settings.deepseekApiKey || '';
      if (contextInput) contextInput.value = String(settings.maxContextTokens || 16384);

      switchProviderTab(settings.provider || 'ollama');
    } catch (err) {
      console.error('Failed to load settings:', err);
    }

    // Clear previous test results
    clearTestResults();

    overlay.classList.add('active');
  }

  function closeSettings() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay) overlay.classList.remove('active');
  }

  function switchProviderTab(provider) {
    // Update tab buttons
    document.querySelectorAll('.provider-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.provider === provider);
    });

    // Update config panels
    document.getElementById('config-ollama')?.classList.toggle('active', provider === 'ollama');
    document.getElementById('config-deepseek')?.classList.toggle('active', provider === 'deepseek');
  }

  function getSelectedProvider() {
    const activeTab = document.querySelector('.provider-tab.active');
    return activeTab ? activeTab.dataset.provider : 'ollama';
  }

  async function testOllamaConnection() {
    const btn = document.getElementById('test-ollama-btn');
    const resultEl = document.getElementById('ollama-result');
    const host = document.getElementById('ollama-host')?.value?.trim() || 'localhost';
    const port = parseInt(document.getElementById('ollama-port')?.value, 10) || 11434;

    if (!btn || !resultEl) return;

    btn.classList.add('testing');
    btn.innerHTML = '<span>⏳</span> Testing...';
    resultEl.className = 'connection-result';
    resultEl.classList.remove('visible');

    try {
      const result = await window.kode.testConnection({
        provider: 'ollama',
        ollamaHost: host,
        ollamaPort: port,
      });

      resultEl.classList.add('visible');
      if (result.connected) {
        resultEl.className = 'connection-result visible success';
        resultEl.textContent = `✅ Connected to Ollama at ${host}:${port}`;
      } else {
        resultEl.className = 'connection-result visible error';
        resultEl.textContent = `❌ Cannot connect: ${result.error || 'Unknown error'}`;
      }
    } catch (err) {
      resultEl.className = 'connection-result visible error';
      resultEl.textContent = `❌ Error: ${err.message}`;
    } finally {
      btn.classList.remove('testing');
      btn.innerHTML = '<span>🔍</span> Test Connection';
    }
  }

  async function testDeepseekConnection() {
    const btn = document.getElementById('test-deepseek-btn');
    const resultEl = document.getElementById('deepseek-result');
    const apiKey = document.getElementById('deepseek-key')?.value?.trim() || '';

    if (!btn || !resultEl) return;

    if (!apiKey) {
      resultEl.className = 'connection-result visible error';
      resultEl.textContent = '❌ Please enter an API key';
      return;
    }

    btn.classList.add('testing');
    btn.innerHTML = '<span>⏳</span> Testing...';
    resultEl.className = 'connection-result';
    resultEl.classList.remove('visible');

    try {
      const result = await window.kode.testConnection({
        provider: 'deepseek',
        deepseekApiKey: apiKey,
      });

      resultEl.classList.add('visible');
      if (result.connected) {
        resultEl.className = 'connection-result visible success';
        resultEl.textContent = '✅ DeepSeek API key is valid';
      } else {
        resultEl.className = 'connection-result visible error';
        resultEl.textContent = `❌ Invalid: ${result.error || 'Authentication failed'}`;
      }
    } catch (err) {
      resultEl.className = 'connection-result visible error';
      resultEl.textContent = `❌ Error: ${err.message}`;
    } finally {
      btn.classList.remove('testing');
      btn.innerHTML = '<span>🔍</span> Test API Key';
    }
  }

  function clearTestResults() {
    ['ollama-result', 'deepseek-result'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.className = 'connection-result';
        el.textContent = '';
      }
    });
  }

  async function saveSettingsHandler() {
    const provider = getSelectedProvider();
    const host = document.getElementById('ollama-host')?.value?.trim() || 'localhost';
    const port = parseInt(document.getElementById('ollama-port')?.value, 10) || 11434;
    const apiKey = document.getElementById('deepseek-key')?.value?.trim() || '';
    const maxContextTokens = parseInt(document.getElementById('max-context-tokens')?.value, 10) || 16384;

    try {
      const result = await window.kode.saveSettings({
        provider,
        ollamaHost: host,
        ollamaPort: port,
        deepseekApiKey: apiKey,
        maxContextTokens,
      });

      if (result.success) {
        closeSettings();
        // Refresh connection status and models (loadModels also refreshes the
        // context-window hint against the newly-saved cap)
        await checkConnection();
        await loadModels();
      } else {
        console.error('Failed to save settings:', result.error);
      }
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  }
})();
