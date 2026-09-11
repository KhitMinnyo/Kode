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
    savePastedImageCalls: [],
    getAttachmentContentCalls: [],
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
    sendMessage: async (tabId, model, message, history, projectPath, images) => {
      captured.sendMessageCalls.push({ tabId, model, message, history, projectPath, images });
      return { success: true };
    },
    savePastedImage: async (bytes, mediaType, name) => {
      captured.savePastedImageCalls.push({ byteLength: bytes.length, mediaType, name });
      return {
        success: true,
        path: `/tmp/pasted-attachments/2026-01-01-${name || "pasted"}.png`,
        name: `${name || "pasted"}.png`,
        mediaType: mediaType || "image/png",
        data: "aGVsbG8=",
      };
    },
    // Mirrors preload: a clipboard image has no path on disk, a copied file does.
    getPathForFile: (file) => file._fakePath || "",
    getAttachmentContent: async (attachedPath) => {
      captured.getAttachmentContentCalls.push(attachedPath);
      return { success: true, type: "file", content: `[Attached file: ${attachedPath}]
contents` };
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

/**
 * Regression: a send-message invoke that fails must end the turn in the UI too.
 *
 * When the main-process handler never replied (a streaming request that could never
 * settle), Electron rejected the pending invoke with "reply was never sent" — and the
 * renderer printed that error while leaving the header exactly as it was: the last
 * status still showing, the elapsed clock still counting up, and the previous turn's
 * token count still on screen. The turn looked alive for as long as the window stayed
 * open, which is what made a failed turn so hard to tell apart from a running one.
 */
test('a failed send-message clears the status bar, the elapsed timer and the token counter', async (t) => {
  const { dom, window, document, captured } = await bootApp();
  after(() => dom.window.close());
  const $ = (sel) => document.querySelector(sel);

  // Reproduce the real sequence: the agent reports it is working and streams a little
  // text (so the header has both a status and a token count), and only then does the
  // IPC call it is waiting on fail.
  window.kode.sendMessage = async (tabId) => {
    captured.onAgentStatus({ tabId, status: 'thinking', message: 'Planning and analyzing...' });
    captured.onStreamToken({ tabId, token: 'partial answer' });
    await new Promise((r) => setTimeout(r, 5));
    throw new Error("Error invoking remote method 'send-message': reply was never sent");
  };

  $('#message-input').value = 'audit this project';
  $('#send-btn').click();
  await new Promise((r) => setTimeout(r, 30));

  await t.test('the failure is reported to the user', () => {
    assert.match(document.getElementById('messages-container').textContent, /reply was never sent/);
  });

  await t.test('the header stops claiming the turn is still running', () => {
    assert.ok(!document.getElementById('agent-status-bar').classList.contains('active'));
    assert.equal(document.getElementById('elapsed-timer').textContent, '');
    assert.equal(document.getElementById('token-counter').textContent, '');
  });

  await t.test('the elapsed timer really is stopped, not just blanked once', async () => {
    // The interval redraws every second, so anything still running would put a value
    // back here — which is exactly what the original bug looked like on screen.
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(document.getElementById('elapsed-timer').textContent, '');
  });
});

/**
 * Regression: the chat box had no paste handler at all, so a screenshot on the
 * clipboard or a file copied in Finder did nothing — only plain text ever got in.
 */
test('pasting a screenshot into the chat box stages it and sends it as an image', async (t) => {
  const { dom, window, document, captured } = await bootApp();
  after(() => dom.window.close());
  const $ = (sel) => document.querySelector(sel);

  const input = $('#message-input');
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file = new window.File([pngBytes], 'Screenshot 2026-09-11.png', { type: 'image/png' });

  /** jsdom has no ClipboardEvent, so drive the handler with the shape it reads. */
  function pasteEvent(items) {
    const evt = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'clipboardData', { value: { items } });
    return evt;
  }

  await t.test('a pasted image becomes a staged chip with a thumbnail', async () => {
    input.dispatchEvent(pasteEvent([{ kind: 'file', type: 'image/png', getAsFile: () => file }]));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(captured.savePastedImageCalls.length, 1, 'clipboard bytes must be written to disk');
    assert.equal(captured.savePastedImageCalls[0].mediaType, 'image/png');

    const row = document.getElementById('attachments-row');
    assert.equal(row.hidden, false);
    assert.ok(row.querySelector('img.attachment-chip-thumb'), 'an image chip shows the image itself');
  });

  await t.test('sending carries the image as image data, not as text', async () => {
    input.value = 'what is this dialog?';
    $('#send-btn').click();
    await new Promise((r) => setTimeout(r, 20));

    const call = captured.sendMessageCalls[0];
    assert.equal(call.images.length, 1);
    assert.equal(call.images[0].data, 'aGVsbG8=');
    assert.equal(call.images[0].mediaType, 'image/png');
    // The model also gets told where the file landed, so its own tools can reach it
    // and a model without vision still knows what it was handed.
    assert.match(call.message, /what is this dialog\?/);
    assert.match(call.message, /\[Attached image: .*\.png\]/);
  });

  await t.test('the tray is emptied once the message is sent', () => {
    assert.equal(document.getElementById('attachments-row').hidden, true);
  });

  await t.test('pasting plain text is left completely alone', async () => {
    const evt = pasteEvent([{ kind: 'string', type: 'text/plain', getAsFile: () => null }]);
    input.dispatchEvent(evt);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(evt.defaultPrevented, false, 'a text paste must keep its default behaviour');
    assert.equal(captured.savePastedImageCalls.length, 1, 'no new image was saved');
    assert.equal(document.getElementById('attachments-row').hidden, true);
  });
});

test('dropping a file from Finder attaches it by path rather than re-reading its bytes', async (t) => {
  const { dom, window, document, captured } = await bootApp();
  after(() => dom.window.close());

  const file = new window.File([new Uint8Array([1, 2, 3])], 'notes.md', { type: 'text/markdown' });
  file._fakePath = '/Users/someone/Documents/notes.md'; // what webUtils.getPathForFile returns

  const dropZone = document.querySelector('.main-content');
  const evt = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
  dropZone.dispatchEvent(evt);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(evt.defaultPrevented, true, 'the drop must be swallowed — Electron would otherwise navigate to the file');
  assert.deepEqual(captured.getAttachmentContentCalls, ['/Users/someone/Documents/notes.md']);
  assert.match(document.getElementById('attachments-row').textContent, /notes\.md/);
});
