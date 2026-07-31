'use strict';

const { EventEmitter } = require('events');

// Cap per-process log buffer so a chatty server (e.g. an access-log-per-request dev
// server) can't grow memory unbounded over a long-running session.
const MAX_LOG_CHARS = 50000;

/**
 * Tracks background/server processes started by the run_command tool
 * (see agent/tools.js's isServerCommand branch).
 *
 * Previously, once a server was detected as successfully started, its stdout/stderr
 * listeners were torn down and the child process was fully detached — meaning any
 * logs or errors printed after the first 3 seconds were silently lost with no way
 * to view them from Kode's UI. This registry keeps a rolling log buffer per process
 * so a "Processes" panel in the renderer can show live output and let the user stop
 * a server, instead of it running invisibly in the background.
 *
 * A single instance is shared across the app (main process only — this never runs
 * in the renderer), so main.js's IPC handlers and tools.js's run_command both see
 * the same registry.
 */
class ProcessManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<number, {pid:number, command:string, cwd:string, port:string|null, startedAt:number, status:'running'|'exited'|'stopped', exitCode:number|null, log:string, child:import('child_process').ChildProcess|null}>} */
    this.processes = new Map();
  }

  register({ pid, command, cwd, port, child }) {
    const entry = {
      pid,
      command,
      cwd: cwd || null,
      port: port || null,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      log: '',
      child,
    };
    this.processes.set(pid, entry);
    this.emit('start', this._publicView(entry));
    return entry;
  }

  appendLog(pid, chunk) {
    const entry = this.processes.get(pid);
    if (!entry || !chunk) return;
    entry.log += chunk;
    if (entry.log.length > MAX_LOG_CHARS) {
      entry.log = entry.log.slice(entry.log.length - MAX_LOG_CHARS);
    }
    this.emit('log', { pid, chunk });
  }

  markExited(pid, code) {
    const entry = this.processes.get(pid);
    if (!entry) return;
    entry.status = 'exited';
    entry.exitCode = typeof code === 'number' ? code : null;
    entry.child = null;
    this.emit('exit', { pid, code: entry.exitCode });
  }

  /** @returns {Array<object>} public-safe view of every tracked process (running + recently exited) */
  list() {
    return [...this.processes.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((e) => this._publicView(e));
  }

  getLog(pid) {
    const entry = this.processes.get(pid);
    return entry ? entry.log : '';
  }

  /**
   * Attempts to terminate a tracked process. Since run_command spawns servers with
   * `detached: true` (making the child the leader of a new process group), killing
   * the negative pid takes down the whole group — important for cases like
   * `npm start` where the tracked pid is a shell wrapping the actual server process.
   */
  stop(pid) {
    const entry = this.processes.get(pid);
    if (!entry || entry.status !== 'running') return false;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        if (entry.child) entry.child.kill('SIGTERM');
        else process.kill(pid, 'SIGTERM');
      } catch (err) {
        return false;
      }
    }
    entry.status = 'stopped';
    entry.child = null;
    this.emit('exit', { pid, code: null });
    return true;
  }

  _publicView(entry) {
    return {
      pid: entry.pid,
      command: entry.command,
      cwd: entry.cwd,
      port: entry.port,
      startedAt: entry.startedAt,
      status: entry.status,
      exitCode: entry.exitCode,
    };
  }
}

// Singleton used throughout the running app (main process only), with the class
// itself also exported so tests can instantiate isolated instances instead of
// sharing global state across test cases.
const singleton = new ProcessManager();
module.exports = singleton;
module.exports.ProcessManager = ProcessManager;
