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
