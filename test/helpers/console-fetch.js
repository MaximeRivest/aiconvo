'use strict';
// Requests from this machine to a server in LAN mode carry the install
// token: being local is not a credential (design/53). Tests register the
// token of each server they boot; loopback requests get it as a Bearer.
const raw = globalThis.fetch;
const tokens = new Map(); // port -> install token
function registerConsole(port, token) { tokens.set(Number(port), token); }
function consoleFetch(url, opts = {}) {
  const s = String(url);
  const m = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(s);
  const token = m && tokens.get(Number(m[1]));
  if (!token) return raw(url, opts);
  const headers = { ...(opts.headers || {}) };
  if (!headers.Cookie && !headers.cookie && !headers.Authorization && !headers.authorization) headers.Authorization = 'Bearer ' + token;
  return raw(url, { ...opts, headers });
}
module.exports = { registerConsole, consoleFetch };
