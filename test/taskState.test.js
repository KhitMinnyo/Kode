'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const taskState = require('../src/agent/taskState');

test('task state classifies work and creates acceptance criteria', () => {
  const change = taskState.createTaskState('fix the login bug and add a regression test');
  assert.equal(change.kind, 'change');
  assert.match(change.criteria.join(' '), /verification/i);

  const writing = taskState.createTaskState('write a Burmese article about remote work');
  assert.equal(writing.kind, 'writing');
  assert.match(writing.criteria.join(' '), /complete requested document/i);

  const command = taskState.createTaskState('run the test suite');
  assert.equal(command.kind, 'command');
});

test('task state persists and clears per project', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-task-state-'));
  const state = taskState.createTaskState('finish the feature');
  assert.equal(taskState.saveTaskState(project, state), true);
  assert.deepEqual(taskState.loadTaskState(project).criteria, state.criteria);
  assert.equal(taskState.clearTaskState(project), true);
  assert.equal(taskState.loadTaskState(project), null);
});

test('task state is stored outside the repository and ignores a planted legacy symlink', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-task-state-link-'));
  const victim = path.join(os.tmpdir(), `kode-victim-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(victim, '{"keep":true}');
  fs.mkdirSync(path.join(project, '.kode'));
  try {
    fs.symlinkSync(victim, path.join(project, '.kode', 'task-state.json'));
  } catch (err) {
    if (process.platform === 'win32') t.skip(`Windows symlink privilege unavailable: ${err.message}`);
    throw err;
  }

  const state = taskState.createTaskState('analyze the project');
  assert.equal(taskState.saveTaskState(project, state), true);
  assert.equal(taskState.taskStatePath(project).startsWith(path.resolve(project) + path.sep), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(victim, 'utf-8')), { keep: true });
  assert.equal(taskState.loadTaskState(project).request, state.request);
  fs.unlinkSync(victim);
});
