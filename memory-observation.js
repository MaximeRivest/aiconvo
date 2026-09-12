'use strict';
function sessionOrigin(text) {
  try {
    const first = JSON.parse(text.split('\n').find(line => line.trim()) || 'null');
    // Pi's session header; Claude's first UUID-bearing conversation record.
    if (first?.type !== 'session' && !(first?.uuid && ['user', 'assistant'].includes(first.type))) return null;
    if (typeof first.timestamp !== 'string') return null;
    const timestamp = Date.parse(first.timestamp);
    return Number.isFinite(timestamp) ? timestamp : null;
  } catch { return null; }
}
function observation(snapshot, event, epoch, activatedAt, now = Date.now()) {
  const originAt = sessionOrigin(snapshot.text), birthtimeMs = snapshot.stat.birthtimeMs;
  const live = event?.kind === 'watch-create' && event.epoch === epoch &&
    event.observedAt > activatedAt && event.observedAt <= now &&
    birthtimeMs > activatedAt && birthtimeMs <= now && birthtimeMs === event.birthtimeMs &&
    snapshot.stat.dev === event.dev && snapshot.stat.ino === event.ino &&
    originAt !== null && originAt > activatedAt && originAt <= now;
  return { kind: live ? 'live-new' : 'baseline-discovery', observedAt: now, originAt,
    birthtimeMs, creationEventAt: event?.observedAt ?? null,
    dev: snapshot.stat.dev, ino: snapshot.stat.ino };
}
module.exports = { sessionOrigin, observation };
