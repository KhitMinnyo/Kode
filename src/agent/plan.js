'use strict';

const fs = require('fs');
const path = require('path');

const PLAN_DIR_NAME = '.kode';
const PLAN_FILE_NAME = 'plan.json';

/**
 * Per-project persistent plan/checklist for Kode's agent. write_plan (agent/tools.js)
 * used to be purely stateless — a formatting helper, nothing written to disk — so a
 * plan laid out in one turn only ever lived in that turn's in-session conversation
 * history. Restart the app, or start a fresh chat on the same project, and the plan
 * (and how far through it the agent had gotten) was gone without a trace, other than
 * whatever the user happened to remember from reading the transcript.
 *
 * Stored at <projectFolder>/.kode/plan.json — same convention as memory.js's
 * memory.json, gitignored for the same reason (personal working data, not source).
 * getSystemPrompt (agent/prompts.js) surfaces an incomplete plan back to the model at
 * the start of a new turn/conversation, so a multi-step task doesn't have to be
 * re-explained from scratch after an app restart or a new chat on the same project.
 */

function planFilePath(projectFolder) {
  return path.join(projectFolder, PLAN_DIR_NAME, PLAN_FILE_NAME);
}

/**
 * @returns {{steps: Array<{text: string, status: string}>, updatedAt: number}|null}
 *   null when there's no project folder, no file yet, or the file is unreadable/junk.
 */
function loadPlan(projectFolder) {
  if (!projectFolder) return null;
  try {
    const filePath = planFilePath(projectFolder);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
    return parsed;
  } catch (err) {
    console.warn('[Plan] Failed to load plan file, treating as none:', err.message);
    return null;
  }
}

function savePlan(projectFolder, steps) {
  if (!projectFolder) return false;
  try {
    const dir = path.join(projectFolder, PLAN_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true });
    const data = { steps, updatedAt: Date.now() };
    fs.writeFileSync(planFilePath(projectFolder), JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.warn('[Plan] Failed to save plan file:', err.message);
    return false;
  }
}

/**
 * Removes the persisted plan file. Called once every step is marked done, so a
 * finished plan doesn't linger on disk and get surfaced as "still in progress" the
 * next time the model starts an unrelated task on the same project.
 */
function clearPlan(projectFolder) {
  if (!projectFolder) return false;
  try {
    const filePath = planFilePath(projectFolder);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    console.warn('[Plan] Failed to clear plan file:', err.message);
    return false;
  }
}

function isPlanComplete(steps) {
  return Array.isArray(steps) && steps.length > 0 &&
    steps.every((s) => s && (s.status === 'done' || s.status === 'completed'));
}

/** Same checklist formatting write_plan has always returned to the model/UI. */
function formatPlan(steps) {
  const lines = (steps || []).map((s, i) => {
    const text = (s && s.text) ? String(s.text) : `Step ${i + 1}`;
    const status = s && typeof s.status === 'string' ? s.status.toLowerCase() : 'pending';
    const box = status === 'done' || status === 'completed' ? '[x]'
      : status === 'in_progress' || status === 'doing' ? '[~]'
      : '[ ]';
    return `${box} ${text}`;
  });
  const done = lines.filter((l) => l.startsWith('[x]')).length;
  return { lines, done, total: lines.length, text: `📋 Plan (${done}/${lines.length} done):\n${lines.join('\n')}` };
}

module.exports = {
  planFilePath,
  loadPlan,
  savePlan,
  clearPlan,
  isPlanComplete,
  formatPlan,
};
