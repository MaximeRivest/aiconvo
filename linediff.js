// Line diff shared by the server and the browser.
//
// The pipeline is the one git's xdiff uses, in this order:
//   1. intern lines to small integers (cheap equality),
//   2. drop the common prefix and suffix,
//   3. lines that occur on only one side can never match, so they leave the
//      problem as forced inserts/deletes before any search runs,
//   4. lines unique in both sides anchor the alignment (patience), and
//   5. linear-space Myers runs only inside the gaps between anchors.
//
// Output is an edit script as a Uint8Array over the two inputs in order:
//   0 = same line (consumes one old and one new line),
//   1 = old line removed, 2 = new line added.
// It is exact, never truncated, and needs O(N + M) memory.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LineDiff = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SAME = 0, OLD = 1, NEW = 2;

  class Script {
    constructor(capacity) { this.buf = new Uint8Array(Math.max(16, capacity)); this.n = 0; }
    push(op) {
      if (this.n === this.buf.length) { const next = new Uint8Array(this.buf.length * 2); next.set(this.buf); this.buf = next; }
      this.buf[this.n++] = op;
    }
    fill(op, count) { for (let i = 0; i < count; i++) this.push(op); }
    result() { return this.buf.subarray(0, this.n); }
  }

  // ---- linear-space Myers on a box of the interned arrays ----
  // Box coordinates: x indexes `a` in [left, right), y indexes `b` in [top, bottom).
  function midpoint(a, b, left, top, right, bottom) {
    const width = right - left, height = bottom - top, delta = width - height;
    if (width + height === 0) return null;
    const max = Math.ceil((width + height) / 2);
    const vf = new Int32Array(2 * max + 3), vb = new Int32Array(2 * max + 3);
    const off = max + 1;
    vf[off + 1] = left;
    vb[off + 1] = bottom;
    const oddDelta = (delta & 1) !== 0;
    for (let d = 0; d <= max; d++) {
      // forward
      for (let k = d; k >= -d; k -= 2) {
        const c = k - delta;
        let x, px;
        if (k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1])) { px = x = vf[off + k + 1]; }
        else { px = vf[off + k - 1]; x = px + 1; }
        let y = top + (x - left) - k;
        const py = (d === 0 || x !== px) ? y : y - 1;
        while (x < right && y < bottom && a[x] === b[y]) { x++; y++; }
        vf[off + k] = x;
        if (oddDelta && c >= -(d - 1) && c <= d - 1 && y >= vb[off + c]) return [px, py, x, y];
      }
      // backward
      for (let c = d; c >= -d; c -= 2) {
        const k = c + delta;
        let y, py;
        if (c === -d || (c !== d && vb[off + c - 1] > vb[off + c + 1])) { py = y = vb[off + c + 1]; }
        else { py = vb[off + c - 1]; y = py - 1; }
        let x = left + (y - top) + k;
        const px = (d === 0 || y !== py) ? x : x + 1;
        while (x > left && y > top && a[x - 1] === b[y - 1]) { x--; y--; }
        vb[off + c] = y;
        if (!oddDelta && k >= -d && k <= d && x <= vf[off + k]) return [x, y, px, py];
      }
    }
    return null;
  }

  // Emits the edit script for the box by walking the recursive snake path.
  function myersBox(a, b, left, top, right, bottom, out) {
    // Trim what is cheap to trim so every box starts with a real difference.
    while (left < right && top < bottom && a[left] === b[top]) { out.push(SAME); left++; top++; }
    let tail = 0;
    while (right > left && bottom > top && a[right - 1] === b[bottom - 1]) { right--; bottom--; tail++; }
    if (left === right) out.fill(NEW, bottom - top);
    else if (top === bottom) out.fill(OLD, right - left);
    else {
      const snake = midpoint(a, b, left, top, right, bottom);
      if (!snake) { out.fill(OLD, right - left); out.fill(NEW, bottom - top); }
      else {
        const [sx, sy, ex, ey] = snake;
        myersBox(a, b, left, top, sx, sy, out);
        walkSnake(a, b, sx, sy, ex, ey, out);
        myersBox(a, b, ex, ey, right, bottom, out);
      }
    }
    out.fill(SAME, tail);
  }

  // A snake is at most one horizontal or vertical step followed by a diagonal.
  function walkSnake(a, b, x1, y1, x2, y2, out) {
    while (x1 < x2 && y1 < y2 && a[x1] === b[y1]) { out.push(SAME); x1++; y1++; }
    if (x2 - x1 < y2 - y1) { out.push(NEW); y1++; }
    else if (x2 - x1 > y2 - y1) { out.push(OLD); x1++; }
    while (x1 < x2 && y1 < y2) { out.push(SAME); x1++; y1++; }
  }

  // ---- reduction: lines absent from the other side are decided up front ----
  function reducedBox(a, b, left, top, right, bottom, out) {
    const inB = new Set(), inA = new Set();
    for (let y = top; y < bottom; y++) inB.add(b[y]);
    for (let x = left; x < right; x++) inA.add(a[x]);
    const ia = [], ib = [];
    for (let x = left; x < right; x++) if (inB.has(a[x])) ia.push(x);
    for (let y = top; y < bottom; y++) if (inA.has(b[y])) ib.push(y);
    if (ia.length === right - left && ib.length === bottom - top) { myersBox(a, b, left, top, right, bottom, out); return; }
    const ra = new Int32Array(ia.length), rb = new Int32Array(ib.length);
    for (let i = 0; i < ia.length; i++) ra[i] = a[ia[i]];
    for (let j = 0; j < ib.length; j++) rb[j] = b[ib[j]];
    const inner = new Script(ra.length + rb.length);
    myersBox(ra, rb, 0, 0, ra.length, rb.length, inner);
    // Expand the reduced script back to the original index space.
    const ops = inner.result();
    let pa = left, pb = top, i = 0, j = 0;
    for (let k = 0; k < ops.length; k++) {
      const op = ops[k];
      if (op === SAME) {
        const ax = ia[i++], by = ib[j++];
        out.fill(OLD, ax - pa); out.fill(NEW, by - pb);
        out.push(SAME); pa = ax + 1; pb = by + 1;
      } else if (op === OLD) {
        const ax = ia[i++];
        out.fill(OLD, ax - pa); out.push(OLD); pa = ax + 1;
      } else {
        const by = ib[j++];
        out.fill(NEW, by - pb); out.push(NEW); pb = by + 1;
      }
    }
    out.fill(OLD, right - pa); out.fill(NEW, bottom - pb);
  }

  // ---- patience anchors: lines unique on both sides, longest increasing run ----
  function patienceBox(a, b, left, top, right, bottom, out, depth) {
    while (left < right && top < bottom && a[left] === b[top]) { out.push(SAME); left++; top++; }
    let tail = 0;
    while (right > left && bottom > top && a[right - 1] === b[bottom - 1]) { right--; bottom--; tail++; }
    if (left === right) out.fill(NEW, bottom - top);
    else if (top === bottom) out.fill(OLD, right - left);
    else {
      const anchors = depth < 24 ? uniqueAnchors(a, b, left, top, right, bottom) : null;
      if (!anchors || !anchors.length) reducedBox(a, b, left, top, right, bottom, out);
      else {
        let px = left, py = top;
        for (let i = 0; i < anchors.length; i += 2) {
          const ax = anchors[i], by = anchors[i + 1];
          patienceBox(a, b, px, py, ax, by, out, depth + 1);
          out.push(SAME);
          px = ax + 1; py = by + 1;
        }
        patienceBox(a, b, px, py, right, bottom, out, depth + 1);
      }
    }
    out.fill(SAME, tail);
  }

  function uniqueAnchors(a, b, left, top, right, bottom) {
    const countA = new Map(), countB = new Map();
    for (let x = left; x < right; x++) countA.set(a[x], (countA.get(a[x]) || 0) + 1);
    for (let y = top; y < bottom; y++) countB.set(b[y], (countB.get(b[y]) || 0) + 1);
    const posB = new Map();
    for (let y = top; y < bottom; y++) if (countB.get(b[y]) === 1 && countA.get(b[y]) === 1) posB.set(b[y], y);
    if (!posB.size) return null;
    // Candidates in old order; find the longest increasing subsequence in new order.
    const xs = [], ys = [];
    for (let x = left; x < right; x++) { const y = posB.get(a[x]); if (y !== undefined) { xs.push(x); ys.push(y); } }
    const n = ys.length;
    const tails = [], tailIdx = [], prev = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < ys[i]) lo = mid + 1; else hi = mid; }
      tails[lo] = ys[i]; tailIdx[lo] = i;
      prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
    }
    const outAnchors = new Array(tails.length * 2);
    let k = tailIdx[tails.length - 1];
    for (let i = tails.length - 1; i >= 0; i--) { outAnchors[2 * i] = xs[k]; outAnchors[2 * i + 1] = ys[k]; k = prev[k]; }
    return outAnchors;
  }

  function intern(lines, table) {
    const ids = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      let id = table.get(lines[i]);
      if (id === undefined) { id = table.size; table.set(lines[i], id); }
      ids[i] = id;
    }
    return ids;
  }

  // Diff two arrays of lines (strings). Returns the Uint8Array edit script.
  function diffLineArrays(oldLines, newLines) {
    const table = new Map();
    const a = intern(oldLines, table), b = intern(newLines, table);
    const out = new Script(a.length + b.length);
    patienceBox(a, b, 0, 0, a.length, b.length, out, 0);
    return out.result();
  }

  function diffLines(oldText, newText) {
    return diffLineArrays(String(oldText == null ? '' : oldText).split('\n'), String(newText == null ? '' : newText).split('\n'));
  }

  // Counts of removed and added lines for an edit script.
  function scriptStats(script) {
    let same = 0, removed = 0, added = 0;
    for (let i = 0; i < script.length; i++) { const op = script[i]; if (op === SAME) same++; else if (op === OLD) removed++; else added++; }
    return { same, removed, added };
  }

  // Rebuild both sides from the script to check it (tests, debugging).
  function applyScript(script, oldLines, newLines) {
    const oldOut = [], newOut = [];
    let i = 0, j = 0;
    for (let k = 0; k < script.length; k++) {
      const op = script[k];
      if (op === SAME) { oldOut.push(oldLines[i++]); newOut.push(newLines[j++]); }
      else if (op === OLD) oldOut.push(oldLines[i++]);
      else newOut.push(newLines[j++]);
    }
    return { oldLines: oldOut, newLines: newOut, consumedOld: i, consumedNew: j };
  }

  return { SAME, OLD, NEW, diffLines, diffLineArrays, scriptStats, applyScript };
});
