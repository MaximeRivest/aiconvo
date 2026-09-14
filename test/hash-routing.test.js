'use strict';
// Regression tests for the hash-route normalizer.
//
// Background: the route grammar is `#<route>` with no leading slash, but
// links in the wild — agent-composed URLs in transcripts, old bookmarks —
// use the SPA-style `#/file&path=…` form. The router matched none of its
// prefixes for that form, so the link silently fell through to the
// conversation view: a dead link with no feedback. Separately, the two
// dispatch call sites ran decodeURIComponent unguarded, so a literal % in
// a file path (e.g. /50%_done.md) threw inside the hashchange listener and
// killed the navigation silently.
//
// hashRoute() fixes both: tolerate leading slashes, decode safely.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');

function productionHashRoute() {
  const start = app.indexOf('function hashRoute()');
  assert.ok(start >= 0, 'hashRoute() not found in app.html');
  const end = app.indexOf('\n}', start);
  assert.ok(end > start, 'hashRoute() body not terminated');
  const src = app.slice(start, end + 2);
  return location => new Function('location', src + '\nreturn hashRoute();')(location);
}

describe('Scenario: hashRoute() tolerates the links that exist in the wild', () => {
  const hashRoute = productionHashRoute();

  it('given a SPA-style #/file&path= link with percent-encoded spaces, when normalized, then it routes like the slash-free form and decodes the path', () => {
    const out = hashRoute({ hash: '#/file&path=%2Fhome%2Fa%20b%2Fc.md' });
    assert.equal(out, 'file&path=/home/a b/c.md');
  });

  it('given a path containing a literal % (decode would throw), when normalized, then the raw route survives instead of killing navigation', () => {
    const out = hashRoute({ hash: '#file&path=/home/50%_done/final.md' });
    assert.equal(out, 'file&path=/home/50%_done/final.md');
  });

  it('given a conversation-key route, when normalized, then interior slashes are preserved and only the leading one is stripped', () => {
    const out = hashRoute({ hash: '#pi:--home-x--/2026-09-13/session.jsonl' });
    assert.equal(out, 'pi:--home-x--/2026-09-13/session.jsonl');
  });
});

describe('Scenario: every dispatch site routes through the normalizer', () => {
  it('given app.html, then the hashchange listener and the boot dispatch both call dispatchHash(hashRoute())', () => {
    const wired = app.match(/dispatchHash\(hashRoute\(\)/g) || [];
    assert.equal(wired.length, 2, 'expected both dispatch sites to use hashRoute()');
    assert.match(app, /addEventListener\('hashchange', \(\) => \{[\s\S]*?dispatchHash\(hashRoute\(\), \{ restore: true \}\)/, 'hashchange listener wiring changed');
  });
});
