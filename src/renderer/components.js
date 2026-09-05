/* ============================================================
   Kode — AI Agent  |  UI Components
   All helpers exported to window.KodeComponents
   ============================================================ */

(() => {
  'use strict';

  /* ---- Tool icon & color mapping ---- */
  const TOOL_META = {
    create_file:     { icon: '📁', css: 'tool-file',      label: 'Create File' },
    edit_file:       { icon: '✏️', css: 'tool-edit',      label: 'Edit File' },
    read_file:       { icon: '📄', css: 'tool-read',      label: 'Read File' },
    run_command:     { icon: '⌨️', css: 'tool-command',   label: 'Run Command' },
    list_directory:  { icon: '📂', css: 'tool-directory', label: 'List Directory' },
    http_request:    { icon: '🌐', css: 'tool-http',      label: 'HTTP Request' },
    search_files:    { icon: '🔍', css: 'tool-search',    label: 'Search Files' },
    firecrawl_scrape:{ icon: '🕸️', css: 'tool-scrape',    label: 'Scrape Page' },
    web_search:      { icon: '🔎', css: 'tool-search',    label: 'Web Search' },
    save_memory:     { icon: '🧠', css: 'tool-memory',    label: 'Save Memory' },
    recall_memory:   { icon: '🧠', css: 'tool-memory',    label: 'Recall Memory' },
  };

  /**
   * Wrap <pre><code> blocks produced by marked with a header
   * that shows the language label and a copy button.
   */
  function wrapCodeBlocks(container) {
    container.querySelectorAll('pre code').forEach((codeEl) => {
      const pre = codeEl.parentElement;
      if (pre.parentElement.classList.contains('code-block-wrapper')) return; // already wrapped

      // Detect language from hljs class (e.g. "language-python")
      const langClass = [...codeEl.classList].find(c => c.startsWith('language-'));
      const lang = langClass ? langClass.replace('language-', '') : '';

      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper';

      const header = document.createElement('div');
      header.className = 'code-block-header';

      const langLabel = document.createElement('span');
      langLabel.className = 'code-lang';
      langLabel.textContent = lang || 'code';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'code-copy-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(codeEl.textContent).then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        });
      });

      header.append(langLabel, copyBtn);
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.append(header, pre);
    });
  }

  // Force every link DOMPurify lets through to open safely — without this, a
  // rendered <a> from scraped web content or a malicious page could navigate the
  // whole Electron window itself (see main.js's will-navigate guard for the other
  // half of this protection) or silently drop window.opener into a new tab.
  if (typeof DOMPurify !== 'undefined') {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }

  /**
   * Render markdown string → HTML, then apply hljs & code-block wrappers.
   * Returns an element ready to be inserted into the DOM.
   *
   * SECURITY: assistant messages can contain content pulled from arbitrary web pages
   * (firecrawl_scrape, web_search) or project files — none of it is trustworthy, so
   * marked's HTML output is always run through DOMPurify before touching innerHTML.
   * If DOMPurify failed to load for some reason, we fail SAFE (render as plain text)
   * rather than ever inserting unsanitized HTML.
   */
  function renderMarkdown(text) {
    const div = document.createElement('div');
    div.className = 'markdown-body';

    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      marked.setOptions({
        breaks: true,
        gfm: true,
        headerIds: false,
        mangle: false,
      });
      const rawHtml = marked.parse(text || '');
      div.innerHTML = DOMPurify.sanitize(rawHtml);
    } else {
      // marked/DOMPurify failed to load — most likely the vendor/*.js files described in
      // src/renderer/vendor/README.md are missing on disk (they're gitignored and fetched
      // by fetch-vendor-libs.sh; if that never ran, or ran without internet, they simply
      // aren't there). Fail SAFE by rendering as plain text rather than ever risking
      // unsanitized HTML — but make that visible in the UI, not just a devtools console
      // nobody opens, since a silent fallback here is exactly what produced the
      // "wall of un-formatted markdown" bug users saw before this warning existed.
      console.error('[Kode] marked/DOMPurify failed to load — rendering as plain text instead of risking unsanitized HTML.');
      const warning = document.createElement('div');
      warning.className = 'markdown-fallback-warning';
      warning.textContent = '⚠️ Formatting libraries didn\'t load, so this message is shown as plain text. Run "npm install" (or "bash src/renderer/vendor/fetch-vendor-libs.sh") with an internet connection, then restart Kode.';
      div.appendChild(warning);
      const textEl = document.createElement('div');
      textEl.textContent = text || '';
      div.appendChild(textEl);
    }

    // Syntax highlighting
    if (typeof hljs !== 'undefined') {
      div.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block);
      });
    }

    wrapCodeBlocks(div);
    return div;
  }

  /* ==========================================================
     Public API
     ========================================================== */

  /**
   * createMessageElement(role, content, toolResults?)
   * role: 'user' | 'assistant' | 'error'
   */
  function createMessageElement(role, content, toolResults) {
    const msg = document.createElement('div');
    msg.className = `message ${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    // Render markdown for assistant & error; plain text for user
    if (role === 'user') {
      bubble.textContent = content;
    } else {
      const md = renderMarkdown(content);
      bubble.appendChild(md);
    }

    msg.appendChild(bubble);

    // Tool result cards (assistant messages only)
    if (toolResults && toolResults.length) {
      toolResults.forEach((tr) => {
        bubble.appendChild(createToolCard(tr));
      });
    }

    return msg;
  }

  /**
   * truncateMiddle("a very long string", 20) → "a very l…g string" — keeps both ends
   * (usually the informative parts of a path/URL/command) instead of just cutting
   * off the end.
   */
  function truncateMiddle(str, max) {
    if (!str) return '';
    if (str.length <= max) return str;
    const half = Math.max(1, Math.floor((max - 1) / 2));
    return str.slice(0, half) + '…' + str.slice(str.length - half);
  }

  /**
   * Produces a short, human-readable one-line summary of a tool call, shown by
   * default in the collapsed tool-card header instead of a raw JSON dump of its
   * params — e.g. "Ran: npm test" rather than { "command": "npm test" }, or
   * "Created templates/404.html" rather than the file's full HTML content inline.
   * The full params (and result) are still one click away — see .tool-params /
   * .tool-result and the "expanded" toggle below — this only changes what shows up
   * unasked, so the chat doesn't balloon into a wall of raw tool JSON.
   */
  function summarizeToolCall(toolName, params) {
    const p = params || {};
    switch (toolName) {
      case 'create_file':      return p.path ? `Created ${p.path}` : 'Created file';
      case 'edit_file':        return p.path ? `Edited ${p.path}` : 'Edited file';
      case 'read_file':        return p.path ? `Read ${p.path}` : 'Read file';
      case 'run_command':      return p.command ? `Ran: ${truncateMiddle(p.command, 70)}` : 'Ran command';
      case 'run_tests':        return p.command ? `Ran tests: ${truncateMiddle(p.command, 60)}` : 'Ran tests';
      case 'list_directory':   return p.path ? `Listed ${p.path}` : 'Listed directory';
      case 'http_request':     return p.url ? `${(p.method || 'GET').toUpperCase()} ${truncateMiddle(p.url, 55)}` : 'HTTP request';
      case 'search_files':     return p.pattern ? `Searched for "${truncateMiddle(p.pattern, 35)}"${p.path ? ` in ${p.path}` : ''}` : 'Searched files';
      case 'firecrawl_scrape': return p.url ? `Scraped ${truncateMiddle(p.url, 55)}` : 'Scraped page';
      case 'web_search':       return p.query ? `Searched web: "${truncateMiddle(p.query, 45)}"` : 'Web search';
      case 'save_memory':      return p.key ? `Saved memory: ${p.key}` : 'Saved memory';
      case 'recall_memory':    return p.query ? `Recalled memory: "${truncateMiddle(p.query, 35)}"` : 'Recalled memory';
      case 'git_status':       return 'Checked git status';
      case 'git_diff':         return p.path ? `Viewed diff — ${p.path}` : 'Viewed git diff';
      case 'git_checkpoint':   return p.message ? `Checkpoint: ${truncateMiddle(p.message, 45)}` : 'Created git checkpoint';
      case 'git_revert':       return p.file ? `Reverted ${p.file}` : (p.ref ? `Reverted to ${p.ref}` : 'Reverted changes');
      case 'apply_patch':      return 'Applied patch';
      case 'write_plan':       return `Updated plan${Array.isArray(p.steps) ? ` (${p.steps.length} step${p.steps.length === 1 ? '' : 's'})` : ''}`;
      case 'index_codebase':   return 'Indexed codebase';
      case 'semantic_search':  return p.query ? `Searched codebase: "${truncateMiddle(p.query, 35)}"` : 'Semantic search';
      default:                 return toolName;
    }
  }

  /**
   * createToolCard({ tool, params, result })
   */
  function createToolCard(toolExecution) {
    const toolName = toolExecution.tool || 'unknown';
    const meta = TOOL_META[toolName] || { icon: '🔧', css: '', label: toolName };

    const card = document.createElement('div');
    card.className = `tool-card ${meta.css}`;

    // Header (clickable to toggle)
    const header = document.createElement('div');
    header.className = 'tool-card-header';

    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.textContent = meta.icon;

    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = summarizeToolCall(toolName, toolExecution.params);
    name.title = meta.label; // full tool name on hover, since the summary replaces it

    const toggle = document.createElement('span');
    toggle.className = 'tool-toggle';
    toggle.textContent = '▼';

    header.append(icon, name, toggle);

    // Params
    const params = document.createElement('div');
    params.className = 'tool-params';
    const paramText = toolExecution.params
      ? (typeof toolExecution.params === 'string'
          ? toolExecution.params
          : JSON.stringify(toolExecution.params, null, 2))
      : '';
    params.textContent = paramText;

    // Result (collapsible)
    const result = document.createElement('div');
    result.className = 'tool-result';
    const resultText = toolExecution.result
      ? (typeof toolExecution.result === 'string'
          ? toolExecution.result
          : JSON.stringify(toolExecution.result, null, 2))
      : 'No output';
    result.textContent = resultText;

    // Toggle expand / collapse
    header.addEventListener('click', () => {
      card.classList.toggle('expanded');
    });

    card.append(header, params, result);
    return card;
  }

  /**
   * createTypingIndicator — three bouncing dots
   */
  function createTypingIndicator() {
    const wrapper = document.createElement('div');
    wrapper.className = 'typing-indicator';
    wrapper.id = 'typing-indicator';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'typing-dot';
      wrapper.appendChild(dot);
    }
    return wrapper;
  }

  /**
   * createWelcomeScreen — shown when conversation is empty
   */
  function createWelcomeScreen() {
    const screen = document.createElement('div');
    screen.className = 'welcome-screen';
    screen.id = 'welcome-screen';

    const logo = document.createElement('div');
    logo.className = 'welcome-logo';
    logo.textContent = 'Kode';

    const subtitle = document.createElement('div');
    subtitle.className = 'welcome-subtitle';
    subtitle.textContent = 'Your AI Coding & Security Agent — Local Ollama or Cloud (OpenAI, Claude, DeepSeek)';

    const prompts = document.createElement('div');
    prompts.className = 'welcome-prompts';

    const examples = [
      { icon: '📁', text: 'Create a Python project structure' },
      { icon: '🔍', text: 'Read and analyze a file' },
      { icon: '⌨️', text: 'Run a shell command' },
      { icon: '🐛', text: 'Fix errors in my code' },
    ];

    examples.forEach(({ icon, text }) => {
      const card = document.createElement('div');
      card.className = 'prompt-card';
      card.dataset.prompt = text;

      const iconSpan = document.createElement('span');
      iconSpan.className = 'prompt-icon';
      iconSpan.textContent = icon;

      const label = document.createElement('span');
      label.textContent = text;

      card.append(iconSpan, label);
      prompts.appendChild(card);
    });

    screen.append(logo, subtitle, prompts);
    return screen;
  }

  /**
   * createModelOption(model) → <option> element
   * model: { name, size, modified_at, details }
   */
  function createModelOption(model) {
    const opt = document.createElement('option');
    opt.value = model.name;

    // Cloud/custom-provider models don't report a real file size — the client
    // always returns 0 for them since there's no local file to measure — so
    // showing "(0 B)" next to an API-hosted model reads as broken. Only append a
    // size badge when there's an actual size (i.e. a local Ollama model).
    const badgeParts = [];
    if (model.size) badgeParts.push(formatFileSize(model.size));
    if (model.details && model.details.parameter_size) badgeParts.push(model.details.parameter_size);

    opt.textContent = badgeParts.length > 0
      ? `${model.name}  (${badgeParts.join(' · ')})`
      : model.name;
    return opt;
  }

  /**
   * formatFileSize(bytes) → "1.2 GB"
   */
  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0);
    return `${val} ${units[i]}`;
  }

  /**
   * createFileTree(treeData) — renders a recursive file tree from data
   * treeData: [{name, path, type, children?, size?}, ...]
   */
  function createFileTree(treeData, onFileClick) {
    const ul = document.createElement('ul');
    ul.className = 'file-tree';

    treeData.forEach(item => {
      const li = document.createElement('li');

      if (item.type === 'directory') {
        li.className = 'file-tree-dir';

        const itemEl = document.createElement('div');
        itemEl.className = 'file-tree-item';

        const chevron = document.createElement('span');
        chevron.className = 'file-tree-chevron';
        chevron.textContent = '▶';

        const icon = document.createElement('span');
        icon.className = 'file-tree-icon';
        icon.textContent = '📁';

        const name = document.createElement('span');
        name.className = 'file-tree-name';
        name.textContent = item.name;

        itemEl.append(chevron, icon, name);
        li.appendChild(itemEl);

        // Click to expand/collapse
        itemEl.addEventListener('click', (e) => {
          e.stopPropagation();
          li.classList.toggle('expanded');
          // Change folder icon
          icon.textContent = li.classList.contains('expanded') ? '📂' : '📁';
        });

        // Render children
        if (item.children && item.children.length > 0) {
          const childUl = createFileTree(item.children, onFileClick);
          childUl.className = '';  // remove 'file-tree' class from nested
          li.appendChild(childUl);
        }
      } else {
        // File
        const itemEl = document.createElement('div');
        itemEl.className = 'file-tree-item';

        const icon = document.createElement('span');
        icon.className = 'file-tree-icon';
        icon.textContent = getFileIcon(item.name);

        const name = document.createElement('span');
        name.className = 'file-tree-name';
        name.textContent = item.name;

        const size = document.createElement('span');
        size.className = 'file-tree-size';
        size.textContent = formatFileSize(item.size || 0);

        itemEl.append(icon, name, size);
        li.appendChild(itemEl);

        // Click to read file
        itemEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (onFileClick) onFileClick(item.path, item.name);
        });
      }

      ul.appendChild(li);
    });

    return ul;
  }

  /**
   * Get an icon for a filename based on its extension
   */
  function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const icons = {
      js: '📜', ts: '📘', jsx: '⚛️', tsx: '⚛️',
      py: '🐍', rb: '💎', go: '🔷', rs: '🦀',
      html: '🌐', css: '🎨', scss: '🎨', less: '🎨',
      json: '📋', yaml: '📋', yml: '📋', toml: '📋',
      xml: '📋',
      md: '📝', txt: '📝', rst: '📝',
      sh: '⚡', bash: '⚡', zsh: '⚡',
      png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
      pdf: '📕', doc: '📕', docx: '📕',
      zip: '📦', tar: '📦', gz: '📦',
      env: '🔒', lock: '🔒',
      sql: '🗄️', db: '🗄️',
    };
    return icons[ext] || '📄';
  }

  /* ---- Expose on window ---- */
  window.KodeComponents = {
    createMessageElement,
    createToolCard,
    createTypingIndicator,
    createWelcomeScreen,
    createModelOption,
    formatFileSize,
    renderMarkdown,
    createFileTree,
    getFileIcon,
  };
})();
