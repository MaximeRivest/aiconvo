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
// hashRoute() fixes both: tolerate leading slashes, decode safely. Since the
// navigation stack (design/44) the route is read in two places, boot and
// popstate, and both feed the stack before dispatching: the stack's entry,
// the rewritten address and currentHash must agree, or a foreign arrival
// becomes two entries.
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

describe('Scenario: every place that reads the address routes through the normalizer', () => {
  it('given app.html, then the popstate listener and the boot both take the route from hashRoute() and hand it to the stack', () => {
    assert.match(app, /addEventListener\('popstate', e => \{[\s\S]*?const hash = hashRoute\(\);\s*const arrival = nav\.arrive\(e\.state, hash\);/, 'popstate wiring changed');
    assert.match(app, /const bootHash = hashRoute\(\);\s*const bootEntry = nav\.load\(bootHash\)/, 'boot wiring changed');
    assert.equal((app.match(/location\.hash\.slice\(1\)/g) || []).length, 1, 'only hashRoute() reads the raw hash');
  });
});
