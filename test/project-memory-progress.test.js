'use strict';
// The project view shows live "done/total" progress for memory work (leaf
// extraction, document regeneration) derived from the jobs map, and falls
// back to the action buttons when nothing runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../app.html'), 'utf8');
const start = html.indexOf('const PROJECT_MEMORY_JOB_TYPES');
const end = html.indexOf('\nfunction renderProjectPanel(', start);
assert.ok(start >= 0 && end > start, 'project memory controls block present');
const barStart = html.indexOf('function barFor(j) {');
const barEnd = html.indexOf('\nfunction jobCardHtml(', barStart);
assert.ok(barStart >= 0 && barEnd > barStart);

function ctx(jobList, sessions = []) {
  const context = {
    jobs: new Map(jobList.map(j => [j.id, j])), sessions,
    projectOf: s => s.project, esc: x => String(x), $: () => null,
    viewKind: 'project', projectOverview: null, projectOverviewName: null,
    postJson: async () => ({}), updateJob() {}, toggleJobs() {}, errToast() {}, confirm: () => true,
    Set, Map, Array, Math, String,
  };
  vm.createContext(context);
  vm.runInContext(html.slice(barStart, barEnd) + '\n' + html.slice(start, end), context);
  return context;
}
const d = { project: 'alpha', memory: { builtAt: 1 }, pyramid: { leaves: { fresh: 5, missing: 3 } } };

test('idle project shows the action buttons, not a spinner', () => {
  const out = ctx([]).projectMemoryControlsHtml(d);
  assert.match(out, /id="pLeafBackfill"[^>]*>update memory leaves \(3\)/);
  assert.match(out, /id="pDocsRegen"[^>]*>regenerate docs/);
  assert.doesNotMatch(out, /pmemjob/);
});

test('a running backfill replaces the button with a counted progress bar', () => {
  const job = { id: 'memory-backfill:alpha', type: 'memory-backfill', project: 'alpha', status: 'running', done: 4, total: 12, statusText: 'Backfill 4/12 leaves…', title: 'alpha: memory leaf backfill', startedAt: 1 };
  const out = ctx([job]).projectMemoryControlsHtml(d);
  assert.doesNotMatch(out, /pLeafBackfill/);
  assert.match(out, /extracting leaves<b>4\/12<\/b>|extracting leaves <b>4\/12<\/b>/);
  assert.match(out, /class="bar">█{5}░{9}</, 'bar reflects 4/12 of 14 cells');
  assert.match(out, /id="pDocsRegen"/, 'docs button stays available while leaves extract');
});

test('document regeneration shows the step text with step counts', () => {
  const job = { id: 'memory-docs:alpha', type: 'memory-docs', project: 'alpha', epicId: null, status: 'running', done: 2, total: 6, statusText: 'Weighing 34 intent quotes…', title: 'alpha: regenerate memory documents', startedAt: 1 };
  const out = ctx([job]).projectMemoryControlsHtml(d);
  assert.doesNotMatch(out, /pDocsRegen/);
  assert.match(out, /Weighing 34 intent quotes <b>2\/6<\/b>/);
});

test('automatic leaf batches count when they touch this project, by projects tag or by key', () => {
  const c = ctx([
    { id: 'memory-extract:1', type: 'memory-extract', projects: ['alpha', 'beta'], status: 'running', done: 1, total: 2, title: '2 memory leaves', startedAt: 2 },
    { id: 'memory-extract:2', type: 'memory-extract', key: 'k1', status: 'running', done: 0, total: 1, title: 'k1', startedAt: 1 },
    { id: 'memory-extract:3', type: 'memory-extract', projects: ['gamma'], status: 'running', done: 0, total: 9, title: 'other', startedAt: 3 },
    { id: 'memory-docs:epic:e1', type: 'memory-docs', project: null, epicId: 'e1', status: 'running', done: 1, total: 3, title: 'epic', startedAt: 4 },
  ], [{ key: 'k1', project: 'alpha' }]);
  assert.equal(Array.from(c.projectMemoryJobs('alpha'), j => j.id).join(','), 'memory-extract:1,memory-extract:2');
  const out = c.projectMemoryControlsHtml(d);
  assert.match(out, /extracting leaves <b>1\/3<\/b>/, 'overlapping leaf jobs merge into one counter');
  assert.doesNotMatch(out, /epic/);
});

test('a job that has not counted yet shows a spinner with its status, and a failed docs job offers a retry', () => {
  const c = ctx([
    { id: 'memory-backfill:alpha', type: 'memory-backfill', project: 'alpha', status: 'running', done: 0, total: 0, statusText: 'Checking leaves…', title: 'bf', startedAt: 2 },
    { id: 'memory-docs:alpha', type: 'memory-docs', project: 'alpha', status: 'error', error: 'model timed out', done: 2, total: 6, title: 'docs', startedAt: 1 },
  ]);
  const out = c.projectMemoryControlsHtml(d);
  assert.match(out, /class="spin">░<\/span> extracting leaves/);
  assert.doesNotMatch(out, /<b>0\/0<\/b>/);
  assert.match(out, /title="model timed out">retry doc regeneration/);
});

test('server tags leaf batches with their projects and exposes them in the job view', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /type: 'memory-extract',[\s\S]{0,400}projects: \[\.\.\.new Set\(keys\.map\(k => projectNameOf\(index\[k\]\.cwd, k\)\)\)\]/);
  const viewStart = server.indexOf('function jobView(job) {');
  const viewEnd = server.indexOf('\n}\n', viewStart) + 3;
  const jobView = vm.runInNewContext(server.slice(viewStart, viewEnd) + '\njobView', {});
  assert.deepEqual(jobView({ id: 'x', type: 'memory-extract', projects: ['a'], startedAt: 1 }).projects, ['a']);
  assert.equal(jobView({ id: 'y', type: 'distill', startedAt: 1 }).projects, null);
});
