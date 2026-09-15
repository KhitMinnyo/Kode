'use strict';

const LMSTUDIO_BASE_URL = 'http://localhost:1234/v1';
const LMSTUDIO_DEFAULT_CONTEXT_SIZE = 8192;

/**
 * Normalizes whatever the user typed for LM Studio's server into a full base URL, so a
 * bare host works: "192.168.1.100:1234" (reach a Mac's LM Studio from Kali over the
 * LAN), "localhost:1234", or a full "http://host:1234/v1" all resolve correctly. The
 * scheme is added if missing (CustomClient does this too, but the path check below
 * needs a parseable URL first), and LM Studio's OpenAI API always lives under /v1, so
 * that's appended when the user gave only a host:port with no path.
 */
function normalizeLmStudioUrl(raw) {
  let u = (raw || '').trim() || LMSTUDIO_BASE_URL;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `http://${u}`;
  try {
    const parsed = new URL(u);
    if (parsed.pathname === '/' || parsed.pathname === '') {
      u = u.replace(/\/+$/, '') + '/v1';
    }
  } catch { /* leave as-is; CustomClient will report the invalid URL */ }
  return u;
}

module.exports = { LMSTUDIO_BASE_URL, LMSTUDIO_DEFAULT_CONTEXT_SIZE, normalizeLmStudioUrl };
