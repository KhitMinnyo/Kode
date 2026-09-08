'use strict';
/**
 * Headless smoke test for the renderer's "true parallel tabs" logic.
 *
 * Loads the REAL index.html (for a faithful DOM) and the REAL app.js (the
 * actual logic under test) into a jsdom window, with stub implementations of
 * window.KodeComponents and window.kode (the IPC bridge) — since neither
 * Electron nor a real main process exists in a test run. This drives the
 * exact same code paths a real user/main-process interaction would, and
 * directly verifies the core claim of the parallel-tabs refactor: a
 * background tab's streamed tokens update its own state without leaking into
 * whatever tab is currently shown, and switching tabs correctly shows each
 * tab's own accumulated content.
 *
 * This exists because two real bugs in exactly this logic (a self-defeating
 * tab-switch guard, and a backgrounded tab's DOM going stale) were found by
 * this exact kind of test and NOT by reading the code — see the git history
 * around the "true parallel tabs" commit. Without this file those regressions
 * had no automated coverage at all: every other test in this suite exercises
 * main-process/agent logic, none of them touch src/renderer/app.js.
 *
 * NOTE: jsdom does not run a real CSS engine, so this intentionally does not
 * attempt to verify the `[hidden]` + `display: flex` interaction fixed
 * alongside this — that bug needs an actual browser/Electron renderer to
 * verify meaningfully; a jsdom-based assertion for it would risk passing or
 * failing for the wrong reasons.
 */
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer');

/**
 * Boots a fresh jsdom window running the real index.html + app.js, with a
 * stubbed window.kode IPC bridge whose calls are all captured for assertions.
 * Every test gets its own independent window/app instance.
 */
async function bootApp() {
  const html = fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'file://' + RENDERER_DIR + '/index.html' });
  const { window } = dom;
  const { document } = window;

  window.KodeComponents = {
    createMessageElement(role, content) {
      const el = document.createElement('div');
      el.className = `message ${role}`;
      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      bubble.textContent = content;
      el.appendChild(bubble);
      return el;
    },
    createToolCard(toolExec) {
      const el = document.createElement('div');
      el.className = 'tool-card';
      el.textContent = `[tool:${toolExec.tool}]`;
      return el;
    },
    createTypingIndicator() {
      const el = document.createElement('div');
      el.id = 'typing-indicator';
      return el;
    },
    createWelcomeScreen() {
      const el = document.createElement('div');
      el.id = 'welcome-screen';
      return el;
    },
    createModelOption(m) {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.name;
      return opt;
    },
    renderMarkdown(text) {
      const span = document.createElement('span');
      span.className = 'rendered-md';
      span.textContent = text;
      return span;
    },
    createFileTree() {
      return document.createElement('ul');
    },
  };

  const captured = {
    sendMessageCalls: [],
    stopGenerationCalls: [],
    closeTabCalls: [],
    respondAskUserCalls: [],
    onStreamToken: null,
    onToolExecution: null,
    onStreamEnd: null,
    onStreamError: null,
    onAgentStatus: null,
    onAskUserRequest: null,
  };
  let chatCounter = 0;

  window.kode = {
    listModels: async () => ({ models: [{ name: 'fake-model' }], provider: 'ollama' }),
    checkConnection: async () => ({ connected: true, provider: 'ollama' }),
    getAppVersion: async () => '1.1.2',
    checkForUpdates: async () => ({ updateAvailable: false }),
    getProjects: async () => ({ projects: [], activeIndex: -1 }),
    getChats: async () => ({ chats: [], activeChatId: null }),
    getSettings: async () => ({ maxContextTokens: 16384 }),
    warmModel: async () => ({ success: true }),
    setActiveProject: async (index) => ({ success: true, activeIndex: index }),
    createChat: async ({ title, model, projectPath }) => {
      chatCounter++;
      return { success: true, chat: { id: `chat_${chatCounter}`, title, model, projectPath, createdAt: Date.now(), updatedAt: Date.now() } };
    },
    saveChat: async () => ({ success: true }),
    updateChatTitle: async () => ({ success: true }),
    setActiveChat: async () => ({ success: false }),
    sendMessage: async (tabId, model, message, history, projectPath) => {
      captured.sendMessageCalls.push({ tabId, model, message, history, projectPath });
      return { success: true };
    },
    stopGeneration: async (tabId) => {
      captured.stopGenerationCalls.push(tabId);
      return { success: true };
    },
    closeTab: async (tabId) => {
      captured.closeTabCalls.push(tabId);
      return { success: true };
    },
    onStreamToken: (cb) => { captured.onStreamToken = cb; return () => {}; },
    onToolExecution: (cb) => { captured.onToolExecution = cb; return () => {}; },
    onStreamEnd: (cb) => { captured.onStreamEnd = cb; return () => {}; },
    onStreamError: (cb) => { captured.onStreamError = cb; return () => {}; },
    onAgentStatus: (cb) => { captured.onAgentStatus = cb; return () => {}; },
    onConfirmCommandRequest: () => () => {},
    onAskUserRequest: (cb) => { captured.onAskUserRequest = cb; return () => {}; },
    respondAskUser: async (requestId, answer) => {
      captured.respondAskUserCalls.push({ requestId, answer });
      return { success: true };
    },
  };

  // jsdom doesn't implement requestAnimationFrame by default.
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);

  const appSrc = fs.readFileSync(path.join(RENDERER_DIR, 'app.js'), 'utf8');
  vm.createContext(window);
  vm.runInContext(appSrc, window, { filename: 'app.js' });

  // jsdom fires its own DOMContentLoaded once parsing completes, asynchronously,
  // possibly after app.js's own listener registration above (script execution
  // here is synchronous, right after JSDOM construction). Don't dispatch a
  // second one — just wait for init() to have run by polling for the tab bar
  // to gain its first pill.
  const tabBarEl = document.getElementById('tab-bar');
  for (let i = 0; i < 200 && tabBarEl.children.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  return { dom, window, document, captured };
}

test('renderer parallel tabs and ask_user modal', async (t) => {
  const { dom, document, captured } = await bootApp();
  // app.js's init() unconditionally starts a real setInterval (the periodic
  // connection health-check) that outlives any of our stimuli and would
  // otherwise keep the test process alive forever. A real Electron window
  // tears this down on page unload; jsdom needs to be told explicitly.
  after(() => dom.window.close());
  const $ = (sel) => document.querySelector(sel);
  const messages = () => $('#messages-container');

  await t.test('startup: exactly one tab, focused, showing the welcome screen', () => {
    const pills = document.querySelectorAll('.tab-pill');
    assert.equal(pills.length, 1);
    assert.ok(pills[0].classList.contains('active'));
    assert.ok(messages().querySelector('#welcome-screen'));
  });

  const input = $('#message-input');
  let tab1Id;

  await t.test('sending a message in tab 1 calls sendMessage with a tabId', async () => {
    input.value = 'Hello from tab 1';
    $('#send-btn').click();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(captured.sendMessageCalls.length, 1);
    tab1Id = captured.sendMessageCalls[0].tabId;
    assert.ok(tab1Id);
    assert.equal(captured.sendMessageCalls[0].message, 'Hello from tab 1');
  });

  await t.test('a focused tab shows its streamed token immediately', async () => {
    captured.onStreamToken({ tabId: tab1Id, token: 'Hello' });
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(messages().textContent.includes('Hello'));
  });

  await t.test('opening a second tab focuses it and hides tab 1\'s content', async () => {
    $('.tab-bar-add-btn').click();
    await new Promise((r) => setTimeout(r, 10));

    const pills = document.querySelectorAll('.tab-pill');
    assert.equal(pills.length, 2);
    assert.ok(pills[1].classList.contains('active'));
    assert.ok(messages().querySelector('#welcome-screen'));
    assert.ok(!messages().textContent.includes('Hello'));
  });

  await t.test('a backgrounded tab keeps accumulating tokens without leaking into the focused tab', async () => {
    captured.onStreamToken({ tabId: tab1Id, token: ' world' });
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(!messages().textContent.includes('Hello'));
  });

  let tab2Id;
  await t.test('sending a message in tab 2 gets its own distinct tabId', async () => {
    input.value = 'Hello from tab 2';
    $('#send-btn').click();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(captured.sendMessageCalls.length, 2);
    tab2Id = captured.sendMessageCalls[1].tabId;
    assert.ok(tab2Id);
    assert.notEqual(tab2Id, tab1Id);
  });

  await t.test('tab 2 shows its own finished response once focused', async () => {
    captured.onStreamToken({ tabId: tab2Id, token: 'Reply for tab 2' });
    await new Promise((r) => setTimeout(r, 5));
    captured.onStreamEnd({ tabId: tab2Id, response: 'Reply for tab 2', toolResults: [] });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(messages().textContent.includes('Reply for tab 2'));
  });

  await t.test('switching back to tab 1 shows everything it accumulated while backgrounded', async () => {
    document.querySelectorAll('.tab-pill')[0].click();
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(document.querySelectorAll('.tab-pill')[0].classList.contains('active'));
    assert.ok(messages().textContent.includes('Hello world'));
    assert.ok(!messages().textContent.includes('Reply for tab 2'));

    captured.onStreamEnd({ tabId: tab1Id, response: 'Hello world', toolResults: [] });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(messages().textContent.includes('Hello world'));
  });

  await t.test('switching to tab 2 again is unaffected by tab 1 finishing separately', async () => {
    document.querySelectorAll('.tab-pill')[1].click();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(messages().textContent.includes('Reply for tab 2'));
    assert.ok(!messages().textContent.includes('Hello world'));
  });

  await t.test('closing a backgrounded tab calls closeTab and leaves the remaining tab intact', async () => {
    const tab1Pill = document.querySelectorAll('.tab-pill')[0];
    tab1Pill.querySelector('.tab-pill-close').click();
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(captured.closeTabCalls.includes(tab1Id));
    const pills = document.querySelectorAll('.tab-pill');
    assert.equal(pills.length, 1);
    assert.ok(messages().textContent.includes('Reply for tab 2'));
  });

  // ask_user modal (see src/agent/tools.js's ask_user tool and app.js's
  // setupAskUserListener) — reuses this same booted app instance rather than
  // calling bootApp() again, since a second full app boot in this file left a
  // dangling handle that kept the test process from exiting cleanly.
  await t.test('a question with options shows the question and renders one button per option', async () => {
    assert.ok(typeof captured.onAskUserRequest === 'function', 'expected setupAskUserListener to have registered onAskUserRequest');

    captured.onAskUserRequest({ requestId: 'req-1', question: 'Which database should this use?', options: ['SQLite', 'Postgres'], tabId: 'tab1' });

    const overlay = document.getElementById('ask-user-overlay');
    assert.ok(overlay.classList.contains('active'), 'expected the modal to open');
    assert.equal(document.getElementById('ask-user-question').textContent, 'Which database should this use?');

    const optionsEl = document.getElementById('ask-user-options');
    assert.equal(optionsEl.hidden, false);
    const buttons = optionsEl.querySelectorAll('.ask-user-option-btn');
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].textContent, 'SQLite');
    assert.equal(buttons[1].textContent, 'Postgres');
  });

  await t.test('clicking an option button responds with that option and closes the modal', async () => {
    const optionsEl = document.getElementById('ask-user-options');
    optionsEl.querySelectorAll('.ask-user-option-btn')[1].click();

    assert.equal(captured.respondAskUserCalls.length, 1);
    assert.deepEqual(captured.respondAskUserCalls[0], { requestId: 'req-1', answer: 'Postgres' });
    assert.ok(!document.getElementById('ask-user-overlay').classList.contains('active'), 'expected the modal to close after answering');
  });

  await t.test('a question with no options hides the button row and free-text still answers it', async () => {
    captured.onAskUserRequest({ requestId: 'req-2', question: 'What should the admin email be?', options: [], tabId: 'tab1' });

    const overlay = document.getElementById('ask-user-overlay');
    assert.ok(overlay.classList.contains('active'));
    assert.equal(document.getElementById('ask-user-options').hidden, true, 'expected no option buttons for an open-ended question');

    const freetext = document.getElementById('ask-user-freetext');
    freetext.value = 'admin@example.com';
    document.getElementById('ask-user-send-btn').click();

    assert.equal(captured.respondAskUserCalls.length, 2);
    assert.deepEqual(captured.respondAskUserCalls[1], { requestId: 'req-2', answer: 'admin@example.com' });
    assert.ok(!overlay.classList.contains('active'));
    assert.equal(freetext.value, '', 'expected the free-text field to clear after answering');
  });

  await t.test('question/option text is inserted as text, never interpreted as HTML', async () => {
    captured.onAskUserRequest({ requestId: 'req-3', question: '<img src=x onerror=alert(1)>', options: ['<b>bold option</b>'], tabId: 'tab1' });

    const questionEl = document.getElementById('ask-user-question');
    assert.equal(questionEl.querySelector('img'), null, 'expected no actual <img> element to have been created');
    assert.equal(questionEl.textContent, '<img src=x onerror=alert(1)>');

    const optionBtn = document.getElementById('ask-user-options').querySelector('.ask-user-option-btn');
    assert.equal(optionBtn.querySelector('b'), null, 'expected no actual <b> element to have been created');
    assert.equal(optionBtn.textContent, '<b>bold option</b>');
  });

  // Auto-continue past AgentCore's per-turn safety limit (see core.js's
  // hitIterationCeiling and app.js's maybeAutoContinue) — reuses tab2, the only tab
  // still open at this point (tab1 was closed above). tab2 is focused and idle
  // (isGenerating false since its own stream-end earlier), matching the real
  // conditions maybeAutoContinue requires before it will act.
  await t.test('hitIterationCeiling in stream-end payload triggers an automatic continue after a short delay', async () => {
    const beforeCount = captured.sendMessageCalls.length;
    captured.onStreamEnd({
      tabId: tab2Id,
      response: '⚠️ Stopped after 25 steps in a single turn (safety limit) — the task may not be fully finished. Ask me to continue and I\'ll pick up from here.',
      toolResults: [],
      hitIterationCeiling: true,
    });

    // Deliberately delayed, not instant — see AUTO_CONTINUE_DELAY_MS in app.js.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(captured.sendMessageCalls.length, beforeCount, 'expected the auto-continue to wait rather than fire immediately');

    await new Promise((r) => setTimeout(r, 1400));
    assert.equal(captured.sendMessageCalls.length, beforeCount + 1, 'expected exactly one automatic follow-up send');
    const autoCall = captured.sendMessageCalls[captured.sendMessageCalls.length - 1];
    assert.equal(autoCall.tabId, tab2Id);
    assert.match(autoCall.message, /auto-continuing/i);
  });

  await t.test('a normal finish (hitIterationCeiling: false) never triggers an auto-continue', async () => {
    const beforeCount = captured.sendMessageCalls.length;
    captured.onStreamEnd({ tabId: tab2Id, response: '✅ Done: finished normally.', toolResults: [], hitIterationCeiling: false });
    await new Promise((r) => setTimeout(r, 1400));
    assert.equal(captured.sendMessageCalls.length, beforeCount, 'expected no automatic follow-up send for a normal finish');
  });
});
