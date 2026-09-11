(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./linediff'));
  else root.LiveFileMarks = factory(root.LineDiff);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (D) {
  'use strict';
  function derive({ text, baseline, original, absent = false, label = 'since opening' }) {
    if ([text, baseline, original].some(s => typeof s !== 'string' || s.length > 2 * 1024 * 1024)) return { unavailable: 'Large file: inline annotations paused' };
    const current = text.split('\n'), base = absent || baseline === '' ? [] : baseline.split('\n'), disk = original.split('\n');
    if (Math.max(current.length, base.length, disk.length) > 50000) return { unavailable: 'Large file: inline annotations paused' };
    const origins = new Uint32Array(current.length + 1);
    let oldLine = 1, newLine = 1;
    for (const op of D.diffLineArrays(disk, current)) {
      if (op === D.SAME) origins[newLine++] = oldLine++;
      else if (op === D.OLD) oldLine++;
      else newLine++;
    }
    const script = D.diffLineArrays(base, text === '' ? [] : current), marks = [];
    let n = 1;
    for (let i = 0; i < script.length;) {
      if (script[i] === D.SAME) { n++; i++; continue; }
      const first = n; let added = 0, removed = 0;
      while (i < script.length && script[i] !== D.SAME) { if (script[i++] === D.NEW) { n++; added++; } else removed++; }
      if (added) for (let line = first; line < first + added; line++) marks.push({ line, glyph: '▎', cls: removed ? 'lf-modified' : 'lf-added', title: (removed ? 'Modified ' : 'Added ') + label });
      else if (removed) marks.push({ line: Math.min(first, current.length), glyph: '▾', cls: 'lf-deleted', title: `${removed} ${removed === 1 ? 'line' : 'lines'} removed ${first > current.length ? 'at end of file' : 'above this line'} · ${label}` });
    }
    return { marks, origins };
  }
  return { derive };
});
