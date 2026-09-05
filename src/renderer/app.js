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
    attachments: [],           // Staged files/folders for the next message: { id, path, name, type, content, status, error }
    _attachmentIdCounter: 0,
  };

  /** Human-readable label per provider — shared by the connection status pill and Settings. */
  const PROVIDER_LABELS = { ollama: 'Ollama', deepseek: 'DeepSeek', openai: 'OpenAI', anthropic: 'Claude', openrouter: 'OpenRouter', custom: 'Custom API' };

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
  const rightPanelFiles   = () => $('#right-panel-files');
  const attachmentsRow    = () => $('#attachments-row');
  const attachFileBtn     = () => $('#attach-file-btn');
  const attachFolderBtn   = () => $('#attach-folder-btn');

  /* ==========================================================
     Initialisation
     ========================================================== */
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    showWelcome();
    setupInputListeners();
    setupStreamListeners();
    setupSettingsListeners();
    setupMemoryListeners();
    setupProcessesListeners();
    setupCommandConfirmListener();
    setupAttachmentListeners();
    setupPanelResizers();
    loadAppVersion();
    setupUpdateBanner();
    checkForUpdates();
    await checkConnection();
    await loadModels();
    await loadProjectFolder();
    setupFolderListeners();
    await loadChatList();

    // Retry connection check every 5 seconds
    setInterval(checkConnection, 5000);
  }

  /**
   * Fetch and display the app version next to the "Kode" logo text.
   * Sourced live from package.json (via Electron's app.getVersion()), so it
   * always stays correct as the version bumps — never hardcode it here.
   */
  async function loadAppVersion() {
    try {
      const version = await window.kode.getAppVersion();
      const el = document.getElementById('app-version');
      if (el && version) el.textContent = `v${version}`;
    } catch {
      // Non-critical — just leave the badge empty if this fails.
    }
  }

  /**
   * Wires up the two dismiss actions on the update-available banner (see index.html):
   * "Not now" just hides it for this session — nothing is remembered, so it shows
   * again next launch as long as this version is still the latest. "Skip this
   * version" remembers the version so it never nags about that SAME release again,
   * but still shows up once an even newer one is published.
   */
  function setupUpdateBanner() {
    const banner = () => document.getElementById('update-banner');

    document.getElementById('update-banner-not-now')?.addEventListener('click', () => {
      const b = banner();
      if (b) b.hidden = true;
    });

    document.getElementById('update-banner-skip')?.addEventListener('click', () => {
      const b = banner();
      if (!b) return;
      try { localStorage.setItem('kode-dismissed-update-version', b.dataset.version || ''); } catch { /* ignore */ }
      b.hidden = true;
    });
  }

  /**
   * Check GitHub Releases for a newer version and, if one exists and the user hasn't
   * already dismissed that exact version, show the update banner with a link to it.
   * Not a silent auto-update — see main.js's check-for-updates handler for why.
   */
  async function checkForUpdates() {
    try {
      const result = await window.kode.checkForUpdates();
      if (!result || !result.updateAvailable || !result.latestVersion) return;

      let dismissedVersion = '';
      try { dismissedVersion = localStorage.getItem('kode-dismissed-update-version') || ''; } catch { /* ignore */ }
      if (dismissedVersion === result.latestVersion) return;

      const banner = document.getElementById('update-banner');
      const text = document.getElementById('update-banner-text');
      const link = document.getElementById('update-banner-link');
      if (!banner || !text || !link) return;

      text.textContent = `🔔 v${result.latestVersion} available`;
      link.href = result.releaseUrl;
      banner.dataset.version = result.latestVersion;
      banner.hidden = false;
    } catch {
      // Non-critical — GitHub unreachable, rate-limited, offline, etc. Fail silently;
      // never block startup or bother the user over a check that couldn't complete.
    }
  }

  /**
   * Wires up the two thin draggable dividers (see index.html's .panel-resizer
   * elements) that let the user resize the left sidebar and the right project-files
   * panel by dragging — the middle chat column just fills whatever space is left
   * (it's `flex: 1`), so widening one side naturally narrows it back down.
   * Widths are stored as CSS custom properties (--sidebar-width / --right-panel-width)
   * on <html> and persisted to localStorage so they stick across restarts; falls back
   * to the CSS defaults if localStorage is unavailable or empty.
   */
  function setupPanelResizers() {
    const MIN_WIDTH = 200;
    const MAX_WIDTH = 560;

    const configs = [
      { id: 'sidebar-resizer', cssVar: '--sidebar-width', storageKey: 'kode-sidebar-width', invert: false },
      { id: 'right-panel-resizer', cssVar: '--right-panel-width', storageKey: 'kode-right-panel-width', invert: true },
    ];

    configs.forEach(({ id, cssVar, storageKey, invert }) => {
      const handle = document.getElementById(id);
      if (!handle) return;

      // Restore a previously-saved width, if any.
      try {
        const saved = parseInt(localStorage.getItem(storageKey), 10);
        if (Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH) {
          document.documentElement.style.setProperty(cssVar, `${saved}px`);
        }
      } catch { /* ignore — just use the CSS default */ }

      let startX = 0;
      let startWidth = 0;

      function onMouseMove(e) {
        const delta = invert ? startX - e.clientX : e.clientX - startX;
        const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
        document.documentElement.style.setProperty(cssVar, `${newWidth}px`);
      }

      function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing-panel');

        const finalWidth = parseInt(
          getComputedStyle(document.documentElement).getPropertyValue(cssVar),
          10
        );
        try {
          if (Number.isFinite(finalWidth)) localStorage.setItem(storageKey, String(finalWidth));
        } catch { /* non-critical — resizing still works this session */ }
      }

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        startWidth = parseInt(
          getComputedStyle(document.documentElement).getPropertyValue(cssVar),
          10
        ) || 0;
        handle.classList.add('dragging');
        document.body.classList.add('resizing-panel');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });

      // Double-click to reset back to the CSS default.
      handle.addEventListener('dblclick', () => {
        document.documentElement.style.removeProperty(cssVar);
        try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
      });
    });
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

    const providerLabel = PROVIDER_LABELS[provider] || 'Ollama';

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
     Attachments — "attach file(s)" / "attach folder", like Claude's own file
     attachment UI. Staged items show as removable chips above the input; on send,
     their content (read via main.js's get-attachment-content, which reuses
     agent/tools.js's own read_file/folder-tree logic) is appended to what the
     MODEL receives, while the chat itself keeps showing just the user's typed text
     plus small static chips — never the raw file content — so attaching a big file
     doesn't balloon the conversation the way un-collapsed tool cards used to.
     ========================================================== */
  function setupAttachmentListeners() {
    const fileBtn = attachFileBtn();
    if (fileBtn) fileBtn.addEventListener('click', async () => {
      try {
        const result = await window.kode.pickAttachmentFiles();
        if (result.success && result.paths) {
          result.paths.forEach((p) => addAttachment(p));
        }
      } catch (err) {
        console.error('Attach file(s) failed:', err);
      }
    });

    const folderBtn = attachFolderBtn();
    if (folderBtn) folderBtn.addEventListener('click', async () => {
      try {
        const result = await window.kode.pickAttachmentFolder();
        if (result.success && result.path) {
          addAttachment(result.path);
        }
      } catch (err) {
        console.error('Attach folder failed:', err);
      }
    });

    // Event delegation for each chip's remove (✕) button
    const row = attachmentsRow();
    if (row) row.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.attachment-chip-remove');
      if (removeBtn) removeAttachment(removeBtn.dataset.id);
    });
  }

  async function addAttachment(attachedPath) {
    // Skip if this exact path is already staged
    if (state.attachments.some(a => a.path === attachedPath)) return;

    const id = String(++state._attachmentIdCounter);
    const name = attachedPath.split(/[\\/]/).pop() || attachedPath;
    state.attachments.push({ id, path: attachedPath, name, type: null, content: null, status: 'loading', error: null });
    renderAttachments();

    try {
      const result = await window.kode.getAttachmentContent(attachedPath);
      const entry = state.attachments.find(a => a.id === id);
      if (!entry) return; // removed while loading
      if (result.success) {
        entry.type = result.type;
        entry.content = result.content;
        entry.status = 'ready';
      } else {
        entry.status = 'error';
        entry.error = result.error || 'Failed to read';
      }
    } catch (err) {
      const entry = state.attachments.find(a => a.id === id);
      if (entry) {
        entry.status = 'error';
        entry.error = err.message || String(err);
      }
    }
    renderAttachments();
  }

  function removeAttachment(id) {
    state.attachments = state.attachments.filter(a => a.id !== id);
    renderAttachments();
  }

  function renderAttachments() {
    const row = attachmentsRow();
    if (!row) return;
    row.innerHTML = '';
    if (state.attachments.length === 0) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    state.attachments.forEach((a) => row.appendChild(createAttachmentChip(a, true)));
  }

  /** Builds one chip. `removable` controls whether a ✕ button is included (staged tray) or not (static, in a sent message). */
  function createAttachmentChip(attachment, removable) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip' + (attachment.status === 'loading' ? ' loading' : '') + (attachment.status === 'error' ? ' error' : '');

    const icon = document.createElement('span');
    icon.className = 'attachment-chip-icon';
    icon.textContent = attachment.status === 'loading' ? '⏳' : attachment.status === 'error' ? '⚠️' : (attachment.type === 'folder' ? '📁' : '📄');

    const name = document.createElement('span');
    name.className = 'attachment-chip-name';
    name.textContent = attachment.name;
    name.title = attachment.status === 'error' ? `${attachment.path} — ${attachment.error}` : attachment.path;

    chip.append(icon, name);

    if (removable) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'attachment-chip-remove';
      removeBtn.dataset.id = attachment.id;
      removeBtn.title = 'Remove';
      removeBtn.textContent = '✕';
      chip.appendChild(removeBtn);
    }

    return chip;
  }

  /** Static, non-removable chip row appended to an already-sent user message. */
  function createAttachmentChipsDisplay(attachments) {
    const wrap = document.createElement('div');
    wrap.className = 'message-attachments';
    attachments.forEach((a) => wrap.appendChild(createAttachmentChip(a, false)));
    return wrap;
  }

  /* ==========================================================
     Send Message
     ========================================================== */
  async function sendMessage() {
    const input = messageInput();
    if (!input) return;

    const text = input.value.trim();
    const readyAttachments = state.attachments.filter(a => a.status === 'ready');
    if ((!text && readyAttachments.length === 0) || state.isGenerating) return;
    if (!state.currentModel) {
      appendError('Please select a model first.');
      return;
    }

    // Clear input, reset height, and empty the attachment tray immediately (like
    // Claude's own attach UI) — this turn's attachments are captured in
    // readyAttachments above before the tray is cleared.
    input.value = '';
    input.style.height = 'auto';
    state.attachments = [];
    renderAttachments();

    // Remove welcome if present
    removeWelcome();

    const displayText = text || (readyAttachments.length === 1 ? `Check ${readyAttachments[0].name}` : 'Check these attachments');

    // Append user message — clean text only; attachment content is injected into
    // messageToSend below, never shown raw here, so a big attached file doesn't
    // balloon the chat itself. Small static chips show what was attached.
    const container = messagesContainer();
    const userMsg = createMessageElement('user', displayText);
    if (readyAttachments.length > 0) {
      const bubble = userMsg.querySelector('.message-bubble');
      if (bubble) bubble.appendChild(createAttachmentChipsDisplay(readyAttachments));
    }
    container.appendChild(userMsg);
    scrollToBottom();

    // Add to history (clean text — matches what's displayed/restored later; the
    // attachment content itself only affects this one turn's request, same
    // one-turn-only scope as core.js's auto-injected project context).
    state.conversationHistory.push({ role: 'user', content: displayText });

    // Auto-create chat if none active
    if (!state.activeChatId) {
      await createNewChat(displayText.substring(0, 40).trim() || 'New Chat');
    }
    // Auto-title if this is the first user message
    if (state.conversationHistory.filter(m => m.role === 'user').length === 1 && state.activeChatId) {
      const autoTitle = displayText.substring(0, 40).trim() + (displayText.length > 40 ? '…' : '');
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

    // Build what the model actually receives: the user's text plus each ready
    // attachment's content (already formatted with a "[Attached file/folder: ...]"
    // header by main.js's get-attachment-content).
    let messageToSend = text;
    if (readyAttachments.length > 0) {
      const attachmentText = readyAttachments.map(a => a.content).join('\n\n');
      messageToSend = text ? `${text}\n\n${attachmentText}` : attachmentText;
    }

    // Send to backend
    try {
      await window.kode.sendMessage(
        state.currentModel,
        messageToSend,
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
      handleToolExecutionForRightPanel(toolExec);

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
    state.attachments = [];
    renderAttachments();
    setGeneratingUI(false);
    showWelcome();
    resetPlanProgress();
    // Deselect active chat in list
    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
  }

  /* ==========================================================
     Multi-Project Management
     ========================================================== */
  function setupFolderListeners() {
    const btn = openFolderBtn();
    if (btn) btn.addEventListener('click', addProject);
    const rightRefreshBtn = document.getElementById('right-panel-refresh-btn');
    if (rightRefreshBtn) rightRefreshBtn.addEventListener('click', refreshRightPanelFiles);
  }

  async function addProject() {
    try {
      const result = await window.kode.addProject();
      if (result.success) {
        state.projects = result.projects;
        state.activeProjectIndex = result.activeIndex;
        renderProjectsList();
        refreshRightPanelFiles();
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
        refreshRightPanelFiles();
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
        refreshRightPanelFiles();
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
        refreshRightPanelFiles();
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
     Right Panel — plan progress + live project files
     ========================================================== */

  /**
   * Refreshes the right panel's file tree for whichever project is currently
   * active. Called on startup, whenever the active project changes, and (debounced)
   * after any tool call that can change what's on disk (create_file, edit_file,
   * apply_patch, git_revert) — so the list stays live without a manual reload.
   */
  async function refreshRightPanelFiles() {
    const container = rightPanelFiles();
    if (!container) return;

    const project = state.projects[state.activeProjectIndex];
    if (!project) {
      container.innerHTML = '<div class="right-panel-empty" id="right-panel-files-empty">No project open</div>';
      return;
    }

    try {
      const result = await window.kode.listFileTree(project.path, 3);
      if (result.success && result.tree && result.tree.length > 0) {
        container.innerHTML = '';
        container.appendChild(createFileTree(result.tree, handleFileClick));
      } else {
        container.innerHTML = '<div class="right-panel-empty">Empty folder</div>';
      }
    } catch (err) {
      container.innerHTML = '<div class="right-panel-empty">Failed to load files</div>';
      console.error('Right panel file tree error:', err);
    }
  }

  const refreshRightPanelFilesDebounced = debounce(refreshRightPanelFiles, 500);

  // Tool calls that can change what's on disk — worth a file-tree refresh.
  const FILE_MUTATING_TOOLS = new Set(['create_file', 'edit_file', 'apply_patch', 'git_revert']);

  /**
   * Updates the right panel's plan-progress bar from a write_plan tool result, which
   * looks like "📋 Plan (2/5 done):\n[x] step one\n[~] step two\n[ ] step three...".
   * Parsed here rather than passed structured, since write_plan's return value is
   * already a plain string (see agent/tools.js) and duplicating that shape over IPC
   * wasn't worth it just for this display.
   */
  function updatePlanProgressFromResult(resultText) {
    const section = document.getElementById('plan-progress-section');
    const fill = document.getElementById('plan-progress-fill');
    const label = document.getElementById('plan-progress-label');
    const stepsEl = document.getElementById('plan-progress-steps');
    if (!section || !fill || !label || !stepsEl) return;

    const text = String(resultText || '');
    const match = text.match(/Plan \((\d+)\/(\d+) done\)/);
    if (!match) return;

    const done = parseInt(match[1], 10);
    const total = parseInt(match[2], 10);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    fill.style.width = `${pct}%`;
    label.textContent = `${done} of ${total} steps done`;

    stepsEl.innerHTML = '';
    const lines = text.split('\n').slice(1); // drop the "📋 Plan (...)" header line
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const li = document.createElement('li');
      if (trimmed.startsWith('[x]')) {
        li.className = 'done';
        li.textContent = trimmed.slice(3).trim();
      } else if (trimmed.startsWith('[~]')) {
        li.className = 'in-progress';
        li.textContent = trimmed.slice(3).trim();
      } else if (trimmed.startsWith('[ ]')) {
        li.textContent = trimmed.slice(3).trim();
      } else {
        li.textContent = trimmed;
      }
      stepsEl.appendChild(li);
    });

    section.hidden = false;
  }

  /** Hides the plan-progress section — called when starting/switching to a chat with no plan of its own yet. */
  function resetPlanProgress() {
    const section = document.getElementById('plan-progress-section');
    if (section) section.hidden = true;
  }

  /** Routes a tool-execution event to whichever right-panel section cares about it. */
  function handleToolExecutionForRightPanel(toolExec) {
    if (toolExec.tool === 'write_plan') {
      updatePlanProgressFromResult(toolExec.result);
    } else if (FILE_MUTATING_TOOLS.has(toolExec.tool)) {
      refreshRightPanelFilesDebounced();
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
        state.attachments = [];
        renderAttachments();
        setGeneratingUI(false);
        resetPlanProgress(); // tool history (including any write_plan) isn't restored below, so neither is this

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
     Memory Modal (per-project long-term memory viewer)
     ========================================================== */
  function setupMemoryListeners() {
    const memoryBtn = document.getElementById('memory-btn');
    const overlay = document.getElementById('memory-overlay');
    const closeBtn = document.getElementById('memory-close-btn');
    const closeBtn2 = document.getElementById('memory-close-btn-2');
    const refreshBtn = document.getElementById('memory-refresh-btn');

    if (memoryBtn) memoryBtn.addEventListener('click', openMemoryPanel);
    if (closeBtn) closeBtn.addEventListener('click', closeMemoryPanel);
    if (closeBtn2) closeBtn2.addEventListener('click', closeMemoryPanel);
    if (refreshBtn) refreshBtn.addEventListener('click', openMemoryPanel);

    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeMemoryPanel();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay && overlay.classList.contains('active')) {
        closeMemoryPanel();
      }
    });
  }

  function closeMemoryPanel() {
    const overlay = document.getElementById('memory-overlay');
    if (overlay) overlay.classList.remove('active');
  }

  async function openMemoryPanel() {
    const overlay = document.getElementById('memory-overlay');
    if (!overlay) return;
    overlay.classList.add('active');

    const listEl = document.getElementById('memory-list');
    if (!listEl) return;
    listEl.textContent = '';

    let result;
    try {
      result = await window.kode.listMemory();
    } catch (err) {
      renderMemoryEmptyState(listEl, `❌ Failed to load memory: ${err.message}`);
      return;
    }

    if (!result || !result.success) {
      renderMemoryEmptyState(listEl, result?.error === 'No active project'
        ? '📁 Open a project folder to view its saved memory.'
        : `❌ ${result?.error || 'Failed to load memory.'}`);
      return;
    }

    renderMemoryList(listEl, result.entries || []);
  }

  function renderMemoryEmptyState(listEl, message) {
    const div = document.createElement('div');
    div.className = 'memory-empty-state';
    div.textContent = message;
    listEl.appendChild(div);
  }

  function renderMemoryList(listEl, entries) {
    if (!entries || entries.length === 0) {
      renderMemoryEmptyState(listEl, '🧠 No memories saved yet for this project. The model will save facts here as it works using save_memory.');
      return;
    }

    // Most recently updated first.
    const sorted = [...entries].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    for (const entry of sorted) {
      const item = document.createElement('div');
      item.className = 'memory-entry';

      const body = document.createElement('div');
      body.className = 'memory-entry-body';

      const keyEl = document.createElement('div');
      keyEl.className = 'memory-entry-key';
      keyEl.textContent = entry.key;
      body.appendChild(keyEl);

      const valueEl = document.createElement('div');
      valueEl.className = 'memory-entry-value';
      valueEl.textContent = entry.value;
      body.appendChild(valueEl);

      const metaParts = [];
      if (Array.isArray(entry.tags) && entry.tags.length > 0) metaParts.push(`tags: ${entry.tags.join(', ')}`);
      if (entry.updatedAt) metaParts.push(`updated ${formatTimeAgo(entry.updatedAt)}`);
      if (metaParts.length > 0) {
        const metaEl = document.createElement('div');
        metaEl.className = 'memory-entry-meta';
        metaEl.textContent = metaParts.join(' · ');
        body.appendChild(metaEl);
      }

      item.appendChild(body);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'memory-entry-delete-btn';
      deleteBtn.textContent = '🗑';
      deleteBtn.title = 'Delete this memory';
      deleteBtn.addEventListener('click', async () => {
        deleteBtn.disabled = true;
        try {
          await window.kode.deleteMemoryEntry(entry.key);
        } catch (err) {
          console.error('Failed to delete memory entry:', err);
        }
        openMemoryPanel();
      });
      item.appendChild(deleteBtn);

      listEl.appendChild(item);
    }
  }

  /* ==========================================================
     Processes Modal (background servers started via run_command)
     ========================================================== */
  // run_command detaches server-type commands (npm start, flask run, ...) so they
  // keep running after the tool call returns; processManager on the main-process
  // side buffers their stdout/stderr so this panel can show it live. Track which
  // process's log is currently expanded so incoming 'process-log' events know
  // whether to append directly to the DOM.
  let expandedProcessPid = null;

  function setupProcessesListeners() {
    const btn = document.getElementById('processes-btn');
    const overlay = document.getElementById('processes-overlay');
    const closeBtn = document.getElementById('processes-close-btn');
    const closeBtn2 = document.getElementById('processes-close-btn-2');
    const refreshBtn = document.getElementById('processes-refresh-btn');

    if (btn) btn.addEventListener('click', openProcessesPanel);
    if (closeBtn) closeBtn.addEventListener('click', closeProcessesPanel);
    if (closeBtn2) closeBtn2.addEventListener('click', closeProcessesPanel);
    if (refreshBtn) refreshBtn.addEventListener('click', openProcessesPanel);

    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeProcessesPanel();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay && overlay.classList.contains('active')) {
        closeProcessesPanel();
      }
    });

    // Live log streaming — only touch the DOM for the entry currently expanded,
    // and only while the panel is open.
    if (window.kode.onProcessLog) {
      window.kode.onProcessLog(({ pid, chunk }) => {
        if (pid !== expandedProcessPid) return;
        const overlayEl = document.getElementById('processes-overlay');
        if (!overlayEl || !overlayEl.classList.contains('active')) return;
        const logEl = document.querySelector(`.process-entry[data-pid="${pid}"] .process-entry-log`);
        if (logEl) {
          logEl.textContent += chunk;
          logEl.scrollTop = logEl.scrollHeight;
        }
      });
    }

    // Start/exit change a process's status badge — cheap enough to just re-render
    // the whole (small) list when the panel is open.
    const refreshIfOpen = () => {
      const overlayEl = document.getElementById('processes-overlay');
      if (overlayEl && overlayEl.classList.contains('active')) openProcessesPanel();
    };
    if (window.kode.onProcessExit) window.kode.onProcessExit(refreshIfOpen);
    if (window.kode.onProcessStart) window.kode.onProcessStart(refreshIfOpen);
  }

  function closeProcessesPanel() {
    const overlay = document.getElementById('processes-overlay');
    if (overlay) overlay.classList.remove('active');
  }

  async function openProcessesPanel() {
    const overlay = document.getElementById('processes-overlay');
    if (!overlay) return;
    overlay.classList.add('active');

    const listEl = document.getElementById('processes-list');
    if (!listEl) return;
    listEl.textContent = '';

    let result;
    try {
      result = await window.kode.listProcesses();
    } catch (err) {
      renderProcessEmptyState(listEl, `❌ Failed to load processes: ${err.message}`);
      return;
    }

    if (!result || !result.success) {
      renderProcessEmptyState(listEl, `❌ ${result?.error || 'Failed to load processes.'}`);
      return;
    }

    renderProcessList(listEl, result.processes || []);
  }

  function renderProcessEmptyState(listEl, message) {
    const div = document.createElement('div');
    div.className = 'process-empty-state';
    div.textContent = message;
    listEl.appendChild(div);
  }

  function renderProcessList(listEl, processes) {
    if (!processes || processes.length === 0) {
      renderProcessEmptyState(listEl, '📟 No background servers yet. When the agent runs something like "npm start" or "flask run", it will show up here.');
      return;
    }

    for (const proc of processes) {
      const item = document.createElement('div');
      item.className = 'process-entry';
      item.dataset.pid = String(proc.pid);
      if (proc.pid === expandedProcessPid) item.classList.add('expanded');

      const header = document.createElement('div');
      header.className = 'process-entry-header';

      const cmd = document.createElement('div');
      cmd.className = 'process-entry-command';
      cmd.textContent = `$ ${proc.command}`;
      cmd.title = proc.command;
      header.appendChild(cmd);

      const meta = document.createElement('div');
      meta.className = 'process-entry-meta';
      const metaParts = [];
      if (proc.port) metaParts.push(`:${proc.port}`);
      metaParts.push(`PID ${proc.pid}`);
      metaParts.push(formatTimeAgo(proc.startedAt));
      meta.textContent = metaParts.join(' · ');
      header.appendChild(meta);

      const badge = document.createElement('span');
      badge.className = `process-status-badge process-status-${proc.status}`;
      badge.textContent = proc.status;
      header.appendChild(badge);

      const stopBtn = document.createElement('button');
      stopBtn.className = 'process-entry-stop-btn';
      stopBtn.textContent = '⏹ Stop';
      stopBtn.disabled = proc.status !== 'running';
      stopBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        stopBtn.disabled = true;
        try {
          await window.kode.stopProcess(proc.pid);
        } catch (err) {
          console.error('Failed to stop process:', err);
        }
        openProcessesPanel();
      });
      header.appendChild(stopBtn);

      const logEl = document.createElement('div');
      logEl.className = 'process-entry-log';

      header.addEventListener('click', async () => {
        const isExpanded = item.classList.toggle('expanded');
        expandedProcessPid = isExpanded ? proc.pid : null;
        if (isExpanded) {
          logEl.textContent = 'Loading…';
          try {
            const logResult = await window.kode.getProcessLog(proc.pid);
            logEl.textContent = (logResult && logResult.log) ? logResult.log : '(no output yet)';
            logEl.scrollTop = logEl.scrollHeight;
          } catch (err) {
            logEl.textContent = `Failed to load log: ${err.message}`;
          }
        }
      });

      item.append(header, logEl);
      listEl.appendChild(item);
    }
  }

  /* ==========================================================
     Risky Command Confirmation Modal
     (shown when Settings → Safety → confirm-risky-commands is on
     and the agent wants to run a "risky but allowed" run_command
     pattern — see src/agent/tools.js / main.js's
     makeConfirmCommandCallback)
     ========================================================== */
  function setupCommandConfirmListener() {
    const overlay = document.getElementById('command-confirm-overlay');
    const labelEl = document.getElementById('command-confirm-label');
    const textEl = document.getElementById('command-confirm-text');
    const blockBtn = document.getElementById('command-confirm-block-btn');
    const allowBtn = document.getElementById('command-confirm-allow-btn');
    if (!overlay || !window.kode.onConfirmCommandRequest) return;

    let activeRequestId = null;

    const respond = (approved) => {
      if (!activeRequestId) return;
      const requestId = activeRequestId;
      activeRequestId = null;
      overlay.classList.remove('active');
      window.kode.respondConfirmCommand(requestId, approved).catch(() => {});
    };

    if (blockBtn) blockBtn.addEventListener('click', () => respond(false));
    if (allowBtn) allowBtn.addEventListener('click', () => respond(true));
    // No overlay-click / Escape-to-dismiss on purpose — an accidental dismiss must
    // never be silently treated as "allow" for a command that pipes/executes remote
    // content. Block/Allow are the only two ways out of this modal.

    window.kode.onConfirmCommandRequest(({ requestId, command, label }) => {
      activeRequestId = requestId;
      if (labelEl) labelEl.textContent = `⚠️ The agent wants to run a command involving ${label}. Review it before allowing.`;
      // textContent (not innerHTML) — command text is untrusted (model/tool output)
      // and must never be interpreted as HTML.
      if (textEl) textEl.textContent = command;
      overlay.classList.add('active');
    });
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
    const tabOpenai = document.getElementById('tab-openai');
    const tabAnthropic = document.getElementById('tab-anthropic');
    const tabOpenrouter = document.getElementById('tab-openrouter');
    const tabCustom = document.getElementById('tab-custom');

    if (tabOllama) tabOllama.addEventListener('click', () => switchProviderTab('ollama'));
    if (tabDeepseek) tabDeepseek.addEventListener('click', () => switchProviderTab('deepseek'));
    if (tabOpenai) tabOpenai.addEventListener('click', () => switchProviderTab('openai'));
    if (tabAnthropic) tabAnthropic.addEventListener('click', () => switchProviderTab('anthropic'));
    if (tabOpenrouter) tabOpenrouter.addEventListener('click', () => switchProviderTab('openrouter'));
    if (tabCustom) tabCustom.addEventListener('click', () => switchProviderTab('custom'));

    // Test buttons
    const testOllama = document.getElementById('test-ollama-btn');
    const testDeepseek = document.getElementById('test-deepseek-btn');
    const testOpenai = document.getElementById('test-openai-btn');
    const testAnthropic = document.getElementById('test-anthropic-btn');
    const testOpenrouter = document.getElementById('test-openrouter-btn');
    const testCustom = document.getElementById('test-custom-btn');

    if (testOllama) testOllama.addEventListener('click', testOllamaConnection);
    if (testDeepseek) testDeepseek.addEventListener('click', testDeepseekConnection);
    if (testOpenai) testOpenai.addEventListener('click', testOpenaiConnection);
    if (testAnthropic) testAnthropic.addEventListener('click', testAnthropicConnection);
    if (testOpenrouter) testOpenrouter.addEventListener('click', testOpenrouterConnection);
    if (testCustom) testCustom.addEventListener('click', testCustomConnection);

    // API key visibility toggles — same pattern for all cloud/custom providers
    setupKeyVisibilityToggle('toggle-key-vis', 'deepseek-key');
    setupKeyVisibilityToggle('toggle-openai-key-vis', 'openai-key');
    setupKeyVisibilityToggle('toggle-anthropic-key-vis', 'anthropic-key');
    setupKeyVisibilityToggle('toggle-openrouter-key-vis', 'openrouter-key');
    setupKeyVisibilityToggle('toggle-custom-key-vis', 'custom-key');
  }

  function setupKeyVisibilityToggle(toggleId, inputId) {
    const toggleVis = document.getElementById(toggleId);
    if (!toggleVis) return;
    toggleVis.addEventListener('click', () => {
      const input = document.getElementById(inputId);
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

  async function openSettings() {
    const overlay = document.getElementById('settings-overlay');
    if (!overlay) return;

    // Load current settings
    try {
      const settings = await window.kode.getSettings();
      const hostInput = document.getElementById('ollama-host');
      const portInput = document.getElementById('ollama-port');
      const keyInput = document.getElementById('deepseek-key');
      const openaiKeyInput = document.getElementById('openai-key');
      const anthropicKeyInput = document.getElementById('anthropic-key');
      const openrouterKeyInput = document.getElementById('openrouter-key');
      const customBaseUrlInput = document.getElementById('custom-base-url');
      const customKeyInput = document.getElementById('custom-key');
      const customContextInput = document.getElementById('custom-context-size');
      const contextInput = document.getElementById('max-context-tokens');
      const confirmRiskyInput = document.getElementById('confirm-risky-commands');

      if (hostInput) hostInput.value = settings.ollamaHost || 'localhost';
      if (portInput) portInput.value = settings.ollamaPort || 11434;
      if (keyInput) keyInput.value = settings.deepseekApiKey || '';
      if (openaiKeyInput) openaiKeyInput.value = settings.openaiApiKey || '';
      if (anthropicKeyInput) anthropicKeyInput.value = settings.anthropicApiKey || '';
      if (openrouterKeyInput) openrouterKeyInput.value = settings.openrouterApiKey || '';
      if (customBaseUrlInput) customBaseUrlInput.value = settings.customBaseUrl || '';
      if (customKeyInput) customKeyInput.value = settings.customApiKey || '';
      if (customContextInput) customContextInput.value = String(settings.customContextSize || 32768);
      if (contextInput) contextInput.value = String(settings.maxContextTokens || 16384);
      if (confirmRiskyInput) confirmRiskyInput.checked = settings.confirmRiskyCommands !== false;

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
    document.getElementById('config-openai')?.classList.toggle('active', provider === 'openai');
    document.getElementById('config-anthropic')?.classList.toggle('active', provider === 'anthropic');
    document.getElementById('config-openrouter')?.classList.toggle('active', provider === 'openrouter');
    document.getElementById('config-custom')?.classList.toggle('active', provider === 'custom');

    // "Max Context Window" (agent/core.js's maxContextCap) only ever applies to Ollama
    // — it exists purely to protect local RAM/VRAM from an oversized KV cache, and is
    // silently ignored for every cloud provider (they always use the model's own real
    // context window instead — see AgentCore._getContextSize). Without this, changing
    // it while a cloud provider is selected looks like it does nothing, because it doesn't.
    const isOllama = provider === 'ollama';
    const contextSelect = document.getElementById('max-context-tokens');
    const contextHint = document.getElementById('context-window-hint');
    const cloudNote = document.getElementById('context-window-cloud-note');
    if (contextSelect) contextSelect.disabled = !isOllama;
    if (contextHint) contextHint.hidden = !isOllama;
    if (cloudNote) {
      cloudNote.hidden = isOllama;
      if (!isOllama) {
        const label = PROVIDER_LABELS[provider] || provider;
        cloudNote.textContent = `ℹ️ This only applies to Ollama (local models) — it protects your machine's RAM/VRAM. ${label} always uses its model's own full context window automatically, so this setting has no effect here.`;
      }
    }
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

  /**
   * Generic "validate an API key against a cloud provider" flow, shared by DeepSeek,
   * OpenAI, and Anthropic — they only differ in which settings key/DOM ids they use.
   */
  async function testApiKeyConnection({ provider, btnId, resultId, inputId, label }) {
    const btn = document.getElementById(btnId);
    const resultEl = document.getElementById(resultId);
    const apiKey = document.getElementById(inputId)?.value?.trim() || '';

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
        provider,
        [`${provider}ApiKey`]: apiKey,
      });

      resultEl.classList.add('visible');
      if (result.connected) {
        resultEl.className = 'connection-result visible success';
        resultEl.textContent = `✅ ${label} API key is valid`;
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

  const testDeepseekConnection = () => testApiKeyConnection({ provider: 'deepseek', btnId: 'test-deepseek-btn', resultId: 'deepseek-result', inputId: 'deepseek-key', label: 'DeepSeek' });
  const testOpenaiConnection = () => testApiKeyConnection({ provider: 'openai', btnId: 'test-openai-btn', resultId: 'openai-result', inputId: 'openai-key', label: 'OpenAI' });
  const testAnthropicConnection = () => testApiKeyConnection({ provider: 'anthropic', btnId: 'test-anthropic-btn', resultId: 'anthropic-result', inputId: 'anthropic-key', label: 'Claude' });
  // OpenRouter's base URL is fixed (see main.js's OPENROUTER_BASE_URL) — only the key
  // is user-supplied, so this fits the plain API-key flow just like the three above.
  const testOpenrouterConnection = () => testApiKeyConnection({ provider: 'openrouter', btnId: 'test-openrouter-btn', resultId: 'openrouter-result', inputId: 'openrouter-key', label: 'OpenRouter' });

  /**
   * "Other (Custom)" needs its own flow rather than testApiKeyConnection() — it
   * requires a base URL (not just an API key, which is itself optional here for
   * no-auth local servers).
   */
  async function testCustomConnection() {
    const btn = document.getElementById('test-custom-btn');
    const resultEl = document.getElementById('custom-result');
    const baseUrl = document.getElementById('custom-base-url')?.value?.trim() || '';
    const apiKey = document.getElementById('custom-key')?.value?.trim() || '';

    if (!btn || !resultEl) return;

    if (!baseUrl) {
      resultEl.className = 'connection-result visible error';
      resultEl.textContent = '❌ Please enter a base URL';
      return;
    }

    btn.classList.add('testing');
    btn.innerHTML = '<span>⏳</span> Testing...';
    resultEl.className = 'connection-result';
    resultEl.classList.remove('visible');

    try {
      const result = await window.kode.testConnection({
        provider: 'custom',
        customBaseUrl: baseUrl,
        customApiKey: apiKey,
      });

      resultEl.classList.add('visible');
      if (result.connected) {
        resultEl.className = 'connection-result visible success';
        resultEl.textContent = '✅ Connected successfully';
      } else {
        resultEl.className = 'connection-result visible error';
        resultEl.textContent = `❌ ${result.error || 'Connection failed'}`;
      }
    } catch (err) {
      resultEl.className = 'connection-result visible error';
      resultEl.textContent = `❌ Error: ${err.message}`;
    } finally {
      btn.classList.remove('testing');
      btn.innerHTML = '<span>🔍</span> Test Connection';
    }
  }

  function clearTestResults() {
    ['ollama-result', 'deepseek-result', 'openai-result', 'anthropic-result', 'openrouter-result', 'custom-result'].forEach(id => {
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
    const openaiApiKey = document.getElementById('openai-key')?.value?.trim() || '';
    const anthropicApiKey = document.getElementById('anthropic-key')?.value?.trim() || '';
    const openrouterApiKey = document.getElementById('openrouter-key')?.value?.trim() || '';
    const customBaseUrl = document.getElementById('custom-base-url')?.value?.trim() || '';
    const customApiKey = document.getElementById('custom-key')?.value?.trim() || '';
    const customContextSize = parseInt(document.getElementById('custom-context-size')?.value, 10) || 32768;
    const maxContextTokens = parseInt(document.getElementById('max-context-tokens')?.value, 10) || 16384;
    const confirmRiskyCommands = document.getElementById('confirm-risky-commands')?.checked !== false;

    try {
      const result = await window.kode.saveSettings({
        provider,
        ollamaHost: host,
        ollamaPort: port,
        deepseekApiKey: apiKey,
        openaiApiKey,
        anthropicApiKey,
        openrouterApiKey,
        customBaseUrl,
        customApiKey,
        customContextSize,
        maxContextTokens,
        confirmRiskyCommands,
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
