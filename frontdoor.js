'use strict';
// frontdoor.js — the doors into this install through Tailscale (design/56).
//
// Two doors share one https name. Serve: the tailnet-only door, for the
// household's own devices. Funnel: the same name opened to the internet,
// for a guest who installs nothing. Both are one handler on port 443 in
// tailscaled's state; the funnel bit is what differs. Turning the public
// door off therefore re-declares the *serve* handler (which clears the
// bit) rather than removing it: a removal would take the everyday door
// down with it.
//
// Pure functions over the CLI's JSON and the API's shape; the server
// supplies exec and fetch. Nothing here needs root; whether the service
// user may change serve config is a Tailscale preference (--operator),
// and the answer says so when it may not.

function parseStatus(text) {
  try {
    const d = JSON.parse(text);
    const self = d && d.Self || {};
    return { dnsName: String(self.DNSName || '').replace(/\.$/, ''), deviceId: self.ID || '', hostName: self.HostName || '', online: !!self.Online, tailnet: d.CurrentTailnet ? d.CurrentTailnet.Name : '' };
  } catch { return null; }
}
// The serve config: is our port behind the https handler, is the funnel bit on.
function parseServe(text, { dnsName, port }) {
  let d = null;
  try { d = JSON.parse(text || '{}'); } catch { return { serve: false, funnel: false }; }
  const hostPort = dnsName + ':443';
  const web = d && d.Web && d.Web[hostPort];
  const root = web && web.Handlers && web.Handlers['/'];
  const target = root && root.Proxy ? String(root.Proxy) : '';
  const serve = !!target && new RegExp(':' + port + '/?$').test(target);
  const funnel = !!(d && d.AllowFunnel && d.AllowFunnel[hostPort]);
  return { serve, funnel, target };
}

// What the CLI said when it refused, in words the settings page can show.
function classifyFailure(text) {
  const t = String(text || '');
  const m = /https:\/\/login\.tailscale\.com\/f\/funnel\?[^\s]*/.exec(t);
  if (m) return { code: 'tailnet', enableUrl: m[0], message: 'Funnel is not enabled on your tailnet yet. It is one click by the tailnet admin; the switch will work right after.' };
  if (/Access denied|serve config denied|operator/i.test(t)) return { code: 'operator', message: 'This user may not change Tailscale serve settings. Once, as root: `sudo tailscale set --operator=' + (process.env.USER || 'you') + '`, then try the switch again.' };
  if (/not running|failed to connect|connection refused/i.test(t)) return { code: 'down', message: 'tailscaled is not running on this machine.' };
  return { code: 'other', message: t.trim().split('\n').filter(Boolean).slice(-1)[0] || 'tailscale refused' };
}

async function doorState({ exec, port }) {
  let statusText = '';
  try { statusText = await exec('tailscale', ['status', '--json']); } catch (e) { return { installed: /ENOENT/.test(String(e.message)) ? false : true, running: false, why: classifyFailure(e.message).message }; }
  const st = parseStatus(statusText);
  if (!st || !st.dnsName) return { installed: true, running: false, why: 'tailscale is installed but not signed in' };
  let serveText = '{}';
  try { serveText = await exec('tailscale', ['serve', 'status', '--json']); } catch {}
  const s = parseServe(serveText, { dnsName: st.dnsName, port });
  return { installed: true, running: true, dnsName: st.dnsName, url: 'https://' + st.dnsName, deviceId: st.deviceId, tailnet: st.tailnet, serve: s.serve, funnel: s.serve && s.funnel, target: s.target };
}

// on: funnel the handler; off: serve it (same handler, funnel bit cleared).
async function setFunnel(on, { exec, port }) {
  const args = [on ? 'funnel' : 'serve', '--bg', '--https=443', 'http://127.0.0.1:' + port];
  try { await exec('tailscale', args); return { ok: true }; }
  catch (e) { return { ok: false, ...classifyFailure(e.message) }; }
}

// A single-use share of this device, minted through the Tailscale API
// (device invites). The person who accepts it sees this one machine on
// their own Tailscale login — nothing else of the tailnet — and can then
// open the tailnet door. Needs an API access token with device rights,
// pasted by the owner into settings.
async function mintDeviceInvite({ fetch, apiKey, deviceId, base = 'https://api.tailscale.com' }) {
  if (!apiKey) throw Object.assign(new Error('no Tailscale API access token in settings → machines'), { code: 'nokey' });
  if (!deviceId) throw new Error('this machine has no Tailscale device id (is tailscale signed in?)');
  const r = await fetch(base + '/api/v2/device/' + encodeURIComponent(deviceId) + '/device-invites', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(apiKey + ':').toString('base64') },
    body: JSON.stringify([{ multiUse: false, allowExitNode: false }]),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error('Tailscale API: ' + (data && data.message || text || r.status));
  const inv = Array.isArray(data) ? data[0] : data;
  if (!inv || !inv.inviteUrl) throw new Error('Tailscale API answered without an invite link');
  return { url: inv.inviteUrl, id: inv.id || null, created: inv.created || new Date().toISOString() };
}

module.exports = { parseStatus, parseServe, classifyFailure, doorState, setFunnel, mintDeviceInvite };
