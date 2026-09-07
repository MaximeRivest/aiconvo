'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../app.html'), 'utf8');
const start = source.indexOf('function projectSetupDialog(');
const end = source.indexOf("$('newProject').onclick", start);
const setup = source.slice(start, end);

test('all inline scripts parse', () => {
  for (const m of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
});

test('folder preview preserves parent and matches new-name normalization', () => {
  const box = vm.createContext({});
  vm.runInContext(setup, box);
  assert.equal(box.projectFolderPreview('/home/user/My Work/', 'New Work'), '/home/user/My Work/New-Work');
  assert.equal(box.projectFolderPreview('/', 'new'), '/new');
  assert.equal(box.projectFolderPreview('', 'new'), '~/Projects/new');
});

test('project setup works in a real browser without starting agents', t => {
  const binary = process.env.CHROMIUM || 'chromium';
  const probe = spawnSync(binary, ['--version'], {encoding: 'utf8'});
  if (probe.error) { t.skip('Set CHROMIUM to run browser checks'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-setup-ui-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const checks = `
const check = (value, message) => { if (!value) throw new Error(message); };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const $ = id => document.getElementById(id);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let requests = [], fail = false, setupVersion = 1;
async function postJson(url, body) { requests.push({url, body}); if (fail) return {error:'Test failure'}; return {project:'example',cwd:'/tmp/example'}; }
async function load() {} async function showProjectOverview() {}
function toast() {} function errToast(message) { throw new Error(message); }
async function fetch() { return {json: async () => ({version:setupVersion,path:'/tmp/My Work',parent:'/tmp',dirs:[{name:'Résumé',known:false}],intent:'Existing purpose'})}; }
(async () => {
 try {
  $('trigger').focus(); openProjectSetup();
  let form = document.querySelector('.ps-card');
  check($('background').inert, 'Background must be inert');
  check(document.activeElement.classList.contains('ps-name'), 'Name receives focus');
  const rect = form.getBoundingClientRect();
  check(rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight, 'Dialog fits viewport');
  check(form.querySelector('.ps-submit').getBoundingClientRect().height >= 44, 'Touch target is large enough');
  check(form.querySelector('.ps-submit').textContent === 'Create project', 'Explicit create button');
  form.querySelector('.ps-name').value = 'New Work';
  form.querySelector('.ps-name').dispatchEvent(new Event('input'));
  check(form.querySelector('.ps-preview').textContent.endsWith('/New-Work'), 'Path preview');
  form.querySelector('.ps-submit').focus();
  form.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',bubbles:true,cancelable:true}));
  check(document.activeElement.name === 'operation', 'Focus wraps');
  const add = form.querySelector('[value="add"]'); add.checked = true; add.dispatchEvent(new Event('change'));
  check(form.querySelector('.ps-create').hidden, 'Create fields hide');
  check(!form.querySelector('.ps-name').required, 'Hidden name not required');
  check(form.querySelector('.ps-submit').textContent === 'Add project', 'Explicit add button');
  form.querySelector('.ps-browse').click(); await tick();
  form.querySelector('.ps-use').click();
  check(form.querySelector('.ps-existing').value === '/tmp/My Work', 'Chosen path stays exact');
  setupVersion = 0; form.requestSubmit(); await tick();
  check(requests.length === 0, 'Old server must never receive setup writes');
  check(form.querySelector('.ps-status').textContent.includes('updated server'), 'Version mismatch explained');
  setupVersion = 1;
  fail = true; form.requestSubmit(); await tick();
  check(form.querySelector('.ps-existing').value === '/tmp/My Work', 'Failure keeps entries');
  check(form.querySelector('.ps-status').textContent.includes('Test failure'), 'Failure visible');
  check(!form.querySelector('.ps-submit').disabled, 'Retry available');
  fail = false; form.requestSubmit(); await tick();
  check(!document.querySelector('.ps-card'), 'Success closes');
  check(!$('background').inert, 'Background restored');
  check(document.activeElement === $('trigger'), 'Trigger focus restored');
  check(requests.every(r => r.url === '/api/project/create' && r.body.operation === 'add' && r.body.path === '/tmp/My Work' && !('firstPrompt' in r.body) && !('git' in r.body)), 'Add requests cannot start or initialize');
  openProjectSetup(); form = document.querySelector('.ps-card');
  form.querySelector('.ps-name').value = 'Another Project';
  form.querySelector('.ps-parent').value = '/tmp';
  form.requestSubmit(); await tick();
  check(requests.at(-1).body.operation === 'create' && !('firstPrompt' in requests.at(-1).body), 'Create never starts an agent');
  await editProjectPurpose('example'); form = document.querySelector('.ps-card');
  check(form.querySelector('.ps-purpose').value === 'Existing purpose', 'Purpose loads separately');
  form.querySelector('.ps-cancel').click();
  check(!$('background').inert, 'Purpose close restores background');
  document.body.dataset.result = 'passed';
 } catch(e) { document.body.dataset.result = 'failed: ' + e.stack; }
})();`;
  const styles = fs.readFileSync(path.join(__dirname, '../design/tokens.css'), 'utf8') + [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + styles + '</style></head><body><main id="background"><button id="trigger">Project</button></main><script>' + setup + '\n' + checks + '</script></body></html>';
  const file = path.join(dir, 'test.html'); fs.writeFileSync(file, html);
  const result = spawnSync(binary, ['--headless','--window-size=390,844','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--user-data-dir=' + path.join(dir,'profile'),'--virtual-time-budget=5000','--dump-dom','file://' + file], {encoding:'utf8',timeout:30000,maxBuffer:5e6});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /data-result="passed"/, result.stdout.match(/data-result="[^"]*"/)?.[0] || result.stderr);
});
