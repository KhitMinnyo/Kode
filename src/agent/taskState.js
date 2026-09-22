'use strict';

const fs = require('fs');
const path = require('path');

const TASK_STATE_FILE = 'task-state.json';

function taskStatePath(projectFolder) {
  return projectFolder ? path.join(projectFolder, '.kode', TASK_STATE_FILE) : null;
}

function classifyTask(message = '') {
  const lower = String(message).toLowerCase();
  if (/essay|article|blog|story|report|proposal|letter|email|documentation|readme|translate|rewrite|proofread|draft|compose|စာရေး|ဆောင်းပါး|အစီရင်ခံစာ|ဘာသာပြန်|ပြန်ရေး|အကျဉ်းချုပ်/i.test(lower)) return 'writing';
  if (/scan|audit|security|vulnerability|pentest|exploit|cve|xss|injection|လုံခြုံ|စစ်ဆေး|ချို့ယွင်း/i.test(lower)) return 'security';
  if (/run|start|stop|execute|test|build|deploy|server|command|ဖွင့်|ရပ်|စမ်း/i.test(lower) &&
      !/\b(write|create|add|implement|fix|refactor|update)\b/i.test(lower)) return 'command';
  if (/fix|implement|add|create|update|modify|remove|refactor|finish|complete|improve|build|migrate|rewrite|ပြင်|ထည့်|ဖန်တီး|ပြီးအောင်/i.test(lower)) return 'change';
  return 'analysis';
}

function criteriaFor(kind) {
  switch (kind) {
    case 'writing': return ['Deliver the complete requested document', 'Match the requested language, audience, tone, and format', 'Silently revise for clarity and consistency'];
    case 'security': return ['Ground findings in code or observed evidence', 'Include severity and concrete remediation', 'Do not claim a vulnerability without verification'];
    case 'command': return ['Execute the requested command or explain a concrete blocker', 'Report the actual result, exit state, or URL'];
    case 'change': return ['Implement the requested change', 'Run the most relevant verification available', 'Report remaining failures instead of claiming success'];
    default: return ['Answer the user directly', 'Separate confirmed facts from assumptions'];
  }
}

function createTaskState(userMessage) {
  const kind = classifyTask(userMessage);
  return {
    version: 1,
    kind,
    request: String(userMessage),
    criteria: criteriaFor(kind),
    status: 'in_progress',
    phase: kind === 'writing' ? 'drafting' : kind === 'analysis' ? 'analyzing' : 'working',
    updatedAt: Date.now(),
  };
}

function loadTaskState(projectFolder) {
  const filePath = taskStatePath(projectFolder);
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!state || state.version !== 1 || !Array.isArray(state.criteria)) return null;
    return state;
  } catch (err) {
    console.warn('[TaskState] Failed to load task state:', err.message);
    return null;
  }
}

function saveTaskState(projectFolder, state) {
  const filePath = taskStatePath(projectFolder);
  if (!filePath || !state) return false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.warn('[TaskState] Failed to save task state:', err.message);
    return false;
  }
}

function clearTaskState(projectFolder) {
  const filePath = taskStatePath(projectFolder);
  if (!filePath) return false;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    console.warn('[TaskState] Failed to clear task state:', err.message);
    return false;
  }
}

function formatTaskState(state) {
  if (!state) return '';
  const criteria = state.criteria.map((item) => `[ ] ${item}`).join('\n');
  return `Task type: ${state.kind}\nPhase: ${state.phase}\nAcceptance criteria:\n${criteria}`;
}

module.exports = {
  taskStatePath,
  classifyTask,
  criteriaFor,
  createTaskState,
  loadTaskState,
  saveTaskState,
  clearTaskState,
  formatTaskState,
};
