'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ProcessManager } = require('../src/agent/processManager');

/**
 * Fresh ProcessManager instance per test (rather than the shared singleton export)
 * so tests don't leak state into one another.
 */
function makeManager() {
  return new ProcessManager();
}

test('register tracks a new process and list() reflects it', () => {
  const pm = makeManager();
  pm.register({ pid: 111, command: 'npm start', cwd: '/tmp/proj', port: '3000', child: null });

  const list = pm.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].pid, 111);
  assert.equal(list[0].command, 'npm start');
  assert.equal(list[0].port, '3000');
  assert.equal(list[0].status, 'running');
});

test('appendLog accumulates chunks and getLog returns the full buffer', () => {
  const pm = makeManager();
  pm.register({ pid: 222, command: 'flask run', cwd: null, port: null, child: null });
  pm.appendLog(222, 'Server started\n');
  pm.appendLog(222, 'GET / 200\n');

  assert.equal(pm.getLog(222), 'Server started\nGET / 200\n');
});

test('appendLog caps the buffer so a chatty process cannot grow memory unbounded', () => {
  const pm = makeManager();
  pm.register({ pid: 333, command: 'node server.js', cwd: null, port: null, child: null });

  // Push well past the 50k cap in small increments, like a real access-logging server would.
  for (let i = 0; i < 6000; i++) {
    pm.appendLog(333, `log line ${i}\n`);
  }

  const log = pm.getLog(333);
  assert.ok(log.length <= 50000, `expected buffered log to stay at or under the cap, got ${log.length}`);
  // The tail (most recent lines) should be preserved, not the head.
  assert.match(log, /log line 5999\n$/);
});

test('appendLog on an unknown pid is a no-op (does not throw or create a phantom entry)', () => {
  const pm = makeManager();
  assert.doesNotThrow(() => pm.appendLog(999, 'orphaned chunk'));
  assert.equal(pm.list().length, 0);
});

test('markExited flips status and clears the child handle', () => {
  const pm = makeManager();
  pm.register({ pid: 444, command: 'node server.js', cwd: null, port: null, child: { fake: true } });
  pm.markExited(444, 1);

  const [entry] = pm.list();
  assert.equal(entry.status, 'exited');
  assert.equal(entry.exitCode, 1);
});

test('emits start/log/exit events for listeners (e.g. main.js forwarding to the renderer)', () => {
  const pm = makeManager();
  const events = [];
  pm.on('start', (e) => events.push(['start', e.pid]));
  pm.on('log', (e) => events.push(['log', e.pid, e.chunk]));
  pm.on('exit', (e) => events.push(['exit', e.pid, e.code]));

  pm.register({ pid: 555, command: 'npm start', cwd: null, port: null, child: null });
  pm.appendLog(555, 'hello\n');
  pm.markExited(555, 0);

  assert.deepEqual(events, [
    ['start', 555],
    ['log', 555, 'hello\n'],
    ['exit', 555, 0],
  ]);
});

test('list() sorts most-recently-started process first', async () => {
  const pm = makeManager();
  pm.register({ pid: 1, command: 'first', cwd: null, port: null, child: null });
  await new Promise((r) => setTimeout(r, 5));
  pm.register({ pid: 2, command: 'second', cwd: null, port: null, child: null });

  const list = pm.list();
  assert.equal(list[0].pid, 2);
  assert.equal(list[1].pid, 1);
});

test('stop() fails gracefully (returns false, no throw, no exit event) when the OS process no longer exists', () => {
  const pm = makeManager();
  // A pid this high is essentially guaranteed not to correspond to a real process,
  // and child is null, so stop() has to fall through both kill attempts and hit
  // its catch — this is the "server already died outside of Kode" case.
  pm.register({ pid: 6060606, command: 'node server.js', cwd: null, port: null, child: null });

  let exitEventFired = false;
  pm.on('exit', () => { exitEventFired = true; });

  const result = pm.stop(6060606);
  assert.equal(result, false);
  assert.equal(exitEventFired, false);
  assert.equal(pm.list()[0].status, 'running', 'a failed stop() should not have mutated status');
});

test('stop() is a no-op for a process that is already marked exited', () => {
  const pm = makeManager();
  pm.register({ pid: 707070, command: 'node server.js', cwd: null, port: null, child: null });
  pm.markExited(707070, 0);

  const result = pm.stop(707070);
  assert.equal(result, false);
  assert.equal(pm.list()[0].status, 'exited', 'status set by markExited should be untouched by a subsequent stop() call');
});

test('stop() sends SIGTERM to a real detached child process and the process actually terminates', async () => {
  const { spawn } = require('node:child_process');
  const pm = makeManager();

  const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  pm.register({ pid: child.pid, command: 'node long-runner.js', cwd: null, port: null, child });

  const exited = new Promise((resolve) => child.on('exit', resolve));

  const result = pm.stop(child.pid);
  assert.equal(result, true);
  assert.equal(pm.list()[0].status, 'stopped');

  // Confirm the signal actually reached the real OS process, not just our bookkeeping.
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('child did not exit after SIGTERM within 3s')), 3000)),
  ]);
});
