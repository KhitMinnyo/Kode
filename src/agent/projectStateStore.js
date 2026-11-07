'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');

function stateRoot() {
  if (process.env.KODE_DATA_DIR) return path.resolve(process.env.KODE_DATA_DIR);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Kode');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Kode');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'kode');
}

function projectStatePath(projectFolder, name) {
  if (!projectFolder) return null;
  const canonical = path.resolve(projectFolder);
  const key = crypto.createHash('sha256').update(canonical).digest('hex');
  return path.join(stateRoot(), 'projects', key, name);
}

module.exports = { stateRoot, projectStatePath };
