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
    onStreamToken: null,
    onToolExecution: null,
    onStreamEnd: null,
    onStreamError: null,
    onAgentStatus: null,
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

test('renderer parallel tabs', async (t) => {
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
});
