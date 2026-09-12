'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync, spawnSync } = require('node:child_process');
const { normalizeSettings, buildPiArgs } = require('../settings');
const ui = require('../memory-settings');

test('settings preserve default text/legacy behavior; explicit provider mapping never enables ambient or unrelated extensions', () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.aiTitles, true); assert.equal(defaults.memoryImages, false); assert.equal(defaults.automaticMemory, 'legacy');
  for (const usePiDefault of [false, true]) {
    const s = normalizeSettings({ usePiDefault, aiTitles: false, memoryImages: true, automaticMemory: 'off' });
    assert.equal(s.aiTitles, false); assert.equal(s.memoryImages, true); assert.equal(s.automaticMemory, 'off');
  }
  const s = { provider: 'fixture', model: 'vision', providerExtensions: { fixture: ['/fixture/provider.ts'], other: ['/fixture/other.ts'] } };
  const args = buildPiArgs(s);
  for (const flag of ['--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-session']) assert.ok(args.includes(flag));
  assert.deepEqual(args.slice(-2), ['-e', '/fixture/provider.ts']); assert.ok(!args.includes('/fixture/other.ts'));
  assert.throws(() => normalizeSettings({ providerExtensions: { fixture: ['relative.ts'] } }), /absolute/);
  assert.throws(() => normalizeSettings({ providerExtensions: [] }), /object/);
  assert.throws(() => normalizeSettings({ automaticMemory: 'unknown' }), /Invalid automaticMemory/);
  assert.throws(() => normalizeSettings({ aiTitles: 'false' }), /boolean/);
});

test('settings status explains coverage, interrupted work, unsupported formats and trusted code without HTML injection', () => {
  const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const html = ui.render({ settings: { provider: '<provider>', aiTitles: false }, memoryAutomation: {
    error: '<corrupt>', pending: [{ key: '<session>', status: 'interrupted', error: '<error>' }], baselineCount: 3,
  } }, esc);
  assert.ok(!html.includes('<session>')); assert.ok(html.includes('&lt;session>'));
  assert.match(html, /notes AND memory/); assert.match(html, /session-origin timestamp/); assert.match(html, /browser JPEG and static PNG/);
  assert.match(html, /Discard without inference/); assert.match(html, /execute trusted code/);
});

test('real browser controls persist opt-ins, require activation/trust confirmation, expose errors and discard without inference', { timeout: 20000 }, t => {
  if (spawnSync('chromium', ['--version']).error) return t.skip('chromium is not installed');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ui-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const page = path.join(root, 'ui.html');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><div id="root"></div><pre id="result"></pre>
    <script src="${pathToFileURL(path.resolve(__dirname, '../memory-settings.js'))}"></script>
    <script>
    const state = {settings:{provider:'fixture',model:'vision',aiTitles:true,memoryImages:false,automaticMemory:'off'},memoryAutomation:{error:'State corrupt',pending:[{key:'synthetic',status:'interrupted'}]}};
    const calls=[]; let consent=false; const root=document.getElementById('root');
    root.innerHTML=MemorySettings.render(state,s=>String(s).replaceAll('<','&lt;'));
    MemorySettings.bind(root,{state:()=>state,save:p=>calls.push(p),confirm:()=>consent,refresh:()=>calls.push('refresh'),discard:k=>calls.push({discard:k})});
    const fire=(id,value)=>{const e=document.getElementById(id); if(e.type==='checkbox')e.checked=value;else e.value=value;e.dispatchEvent(new Event('change'));};
    fire('setAiTitles',false);fire('setMemoryImages',true);fire('setAutomaticMemory','changes-after-enable');
    const denied=document.getElementById('setAutomaticMemory').value;consent=true;fire('setAutomaticMemory','changes-after-enable');
    document.getElementById('setProviderExtensions').value='/fixture/provider.ts';document.getElementById('saveProviderExtensions').click();
    document.querySelector('[data-memory-discard]').click();document.getElementById('refreshMemoryStatus').click();
    document.getElementById('result').textContent=JSON.stringify({calls,denied,status:document.getElementById('memoryAutomationStatus').textContent});
    </script>`);
  const html = execFileSync('chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--disable-extensions', '--user-data-dir=' + path.join(root, 'browser'), '--dump-dom', pathToFileURL(page).href], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = JSON.parse(html.match(/<pre id="result">([^<]+)<\/pre>/)[1]);
  assert.equal(result.denied, 'off'); assert.match(result.status, /State corrupt/);
  assert.deepEqual(result.calls, [{ aiTitles: false }, { memoryImages: true }, { automaticMemory: 'changes-after-enable' },
    { provider: 'fixture', model: 'vision', usePiDefault: false, providerExtensions: { fixture: ['/fixture/provider.ts'] } }, { discard: 'synthetic' }, 'refresh']);
});
