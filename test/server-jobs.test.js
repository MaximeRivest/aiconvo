'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

test('allJobs retains live pipelines, recent restored runs, and model health without the retired batch map', () => {
  const start = source.indexOf('function allJobs() {');
  const end = source.indexOf('\nfunction startDistillJob(', start);
  assert.ok(start >= 0 && end > start);
  const now = Date.now();
  const names = ['distillJobs', 'evidenceJobs', 'epicJobs', 'memoryExtractJobs',
    'memoryDocsJobs', 'memoryBackfillJobs', 'agentRunJobs'];
  const context = { JOB_KEEP_MS: 60000, jobView: job => ({ ...job, viewed: true }),
    memoryModelHealthJobView: () => ({ id: 'health', startedAt: now + 1 }),
    restoredRunJobs: new Map([
      ['recent', { id: 'recent', startedAt: now - 10, finishedAt: now }],
      ['expired', { id: 'expired', startedAt: 0, finishedAt: now - 120000 }],
    ]),
  };
  names.forEach((name, i) => { context[name] = new Map([[name, { id: name, startedAt: now - i }]]); });
  const jobs = vm.runInNewContext(source.slice(start, end) + '\nallJobs()', context);
  assert.deepEqual(Array.from(jobs, job => job.id), ['health', ...names, 'recent']);
  assert.ok(jobs.filter(job => names.includes(job.id)).every(job => job.viewed));
});
