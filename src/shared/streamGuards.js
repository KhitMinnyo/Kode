'use strict';

/**
 * Shared safety nets for the streaming chat requests in the provider clients
 * (anthropic/, custom/, deepseek/, ollama/, openai/).
 *
 * Every one of those clients used to guard a stream with exactly one thing: the
 * in-flight "stall timeout" in chat(), re-armed on every chunk received. That guard
 * has two holes this module closes:
 *
 *   1. It can only fire while data is still arriving. A connection that dies
 *      silently — laptop sleep, network change, a proxy dropping an idle tunnel —
 *      delivers nothing at all, so nothing re-arms and nothing settles the request
 *      promise either. The agent loop then waits on a promise that can never
 *      resolve, which is what left Kode showing "Planning and analyzing..." with a
 *      climbing timer until Electron gave up on the pending send-message call with
 *      "reply was never sent". SOCKET_IDLE_TIMEOUT + TCP keepalive turn that into an
 *      ordinary, reportable error.
 *
 *   2. Re-arming on *every* chunk means any traffic keeps the request alive
 *      indefinitely, even traffic that contains no answer: keep-alive frames, and
 *      the reasoning deltas a reasoning model streams while it thinks. That's what
 *      MAX_TIME_TO_FIRST_OUTPUT is for — a one-shot ceiling, never re-armed, on how
 *      long a request may run without producing a single usable token or tool call.
 *
 * Both are deliberately set above the 5-minute stall timeout so they never pre-empt
 * a healthy-but-slow model; they exist to bound the cases the stall timeout can't see.
 */

/** No bytes at all on the socket for this long ⇒ the connection is dead, not slow. */
const SOCKET_IDLE_TIMEOUT = 360000; // 6 min

/**
 * Hard ceiling on time-to-first-output (text or a tool call). Reasoning/keep-alive
 * traffic does NOT extend this — that's the whole point of it.
 */
const MAX_TIME_TO_FIRST_OUTPUT = 600000; // 10 min

/** Minimum gap between "still thinking" progress events, so reasoning doesn't spam IPC. */
const REASONING_REPORT_INTERVAL = 1000; // 1s

/** Rough chars-per-token ratio, only ever used to show an approximate reasoning count. */
const CHARS_PER_TOKEN = 4;

/**
 * Attaches a socket inactivity timeout, TCP keepalive and the abort signal to an
 * in-flight http(s) request, and returns the error mapper every rejection path must
 * go through.
 *
 * The mapper matters as much as the timeouts: previously an abort surfaced as a bare
 * ECONNRESET, which `req.on('error')` treated as a clean finish (`resolve()`), so the
 * caller's catch — the only place that sets the `stalled` flag — never ran. The agent
 * then saw an ordinary empty response instead of a stall, and retried it on a code
 * path with no retry budget at all. Mapping aborts and dead sockets to explicit,
 * tagged errors is what makes a stall detectable (and therefore budgetable) upstream.
 *
 * @param {import('http').ClientRequest} req
 * @param {{urlPath: string, signal?: AbortSignal|null, idleTimeout?: number}} options
 * @returns {{aborted: boolean, mapError: (err: Error) => Error}}
 */
function guardStreamingRequest(req, { urlPath, signal = null, idleTimeout = SOCKET_IDLE_TIMEOUT } = {}) {
  const state = { aborted: false, timedOut: false };

  // Destroy WITH an explicit error, always. `req.destroy()` with no argument is not
  // guaranteed to emit an 'error' event on the request — on some Node/Electron builds a
  // request torn down mid-response settles only via an ECONNRESET the OS happens to
  // surface, and if it doesn't, the request promise (and the send-message IPC waiting on
  // it) hangs forever — the exact "reply was never sent" failure. Passing an error makes
  // the 'error' event fire deterministically on every version; mapError below keys the
  // caller-visible result off the state flags, not this error's contents, so the flags
  // set here are what decide whether it reads as a timeout or an abort.
  const destroy = (err) => { try { req.destroy(err); } catch { /* already destroyed */ } };

  req.setTimeout(idleTimeout, () => {
    state.timedOut = true;
    destroy(new Error('kode: socket idle timeout'));
  });

  // Detect a peer that went away without closing the connection (the case a socket
  // inactivity timeout alone can miss on some networks).
  const enableKeepAlive = (socket) => {
    try { socket.setKeepAlive(true, 30000); } catch { /* not fatal — the idle timeout still applies */ }
  };
  if (req.socket) enableKeepAlive(req.socket);
  else req.on('socket', enableKeepAlive);

  if (signal) {
    if (signal.aborted) {
      state.aborted = true;
      destroy(new Error('kode: aborted'));
    } else {
      signal.addEventListener('abort', () => {
        state.aborted = true;
        destroy(new Error('kode: aborted'));
      }, { once: true });
    }
  }

  return {
    get aborted() { return state.aborted; },
    mapError(err) {
      if (state.timedOut) {
        return Object.assign(
          new Error(`Streaming request to ${urlPath} received no data for ${Math.round(idleTimeout / 1000)}s — the connection appears dead.`),
          { timedOut: true },
        );
      }
      if (state.aborted) return Object.assign(new Error('Request aborted'), { aborted: true });
      return err;
    },
  };
}

/**
 * One-shot deadline on producing any usable output. Resolves nothing itself — it just
 * aborts the client's current request via the callback, which surfaces through the
 * normal abort path as a stall the agent loop can budget.
 *
 * @param {() => boolean} hasOutput - returns true once a token/tool call has arrived
 * @param {() => void} onDeadline - called only when the deadline passes with no output
 * @returns {NodeJS.Timeout}
 */
function armFirstOutputDeadline(hasOutput, onDeadline, ms = MAX_TIME_TO_FIRST_OUTPUT) {
  return setTimeout(() => {
    if (!hasOutput()) onDeadline();
  }, ms);
}

module.exports = {
  SOCKET_IDLE_TIMEOUT,
  MAX_TIME_TO_FIRST_OUTPUT,
  REASONING_REPORT_INTERVAL,
  CHARS_PER_TOKEN,
  guardStreamingRequest,
  armFirstOutputDeadline,
};
