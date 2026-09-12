(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MemorySettings = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  function render(state, esc) {
    const s = state?.settings || {}, status = state?.memoryAutomation || {};
    const pending = status.pending || [];
    return `<h3>Memory input and automation</h3>
      <label class="set-check"><input id="setAiTitles" type="checkbox"${s.aiTitles !== false ? ' checked' : ''}> AI titles</label>
      <div class="set-help">Off suppresses AI naming, including retitle actions and commit-title amendments. Abstracts and structural summary headings remain.</div>
      <label class="set-check"><input id="setMemoryImages" type="checkbox"${s.memoryImages ? ' checked' : ''}> Inspect source image attachments</label>
      <div class="set-help">Requires an explicit configured image-capable model. Supports browser JPEG and static PNG (including grayscale, palette and interlaced variants) up to 2048×2048. Structural admission is not full JPEG entropy decoding. Other encodings fail explicitly, without a text-only fallback. No URLs are fetched.</div>
      <div class="set-field"><label for="setAutomaticMemory">Automatic notes and memory</label>
      <select id="setAutomaticMemory">${[['legacy', 'Legacy upstream automation'], ['off', 'Off'], ['changes-after-enable', 'Observed changes after enable']].map(([v, label]) => `<option value="${v}"${(s.automaticMemory || 'legacy') === v ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
      <p class="set-help">Legacy preserves upstream triggers and historical retry queues; it is not a no-backfill policy. The new policy writes visible distilled notes AND memory leaves in one serial pipeline; already-built project/area/epic documents refresh from saved leaves. Activation only baselines sources: no inference or historical backfill. Whole-session context can include old messages. New files qualify only when live creation evidence, filesystem birth time and session-origin timestamp are after activation. Restart discovery, old imports and unknown metadata are baselined; subsequent source changes qualify. Producer/host clocks must agree. Interrupted/failed work is not replayed automatically.</p>
      <div id="memoryAutomationStatus" role="status">${esc(status.error || (status.active ? 'Active' : 'Not active under the new policy'))} · ${Number(status.baselineCount) || 0} baselined · ${pending.length} pending/interrupted/errors${status.epoch ? ' · epoch ' + esc(status.epoch) : ''}</div>
      <p class="set-help">${(status.retired || []).length} retired pending/interrupted records retained for audit; they are never eligible in a new epoch.</p>
      <button type="button" id="refreshMemoryStatus">Refresh status</button>
      ${pending.slice(0, 30).map(p => `<p>${esc(p.key)}: ${esc(p.status)}${p.error ? ' — ' + esc(p.error) : ''} <button type="button" data-memory-discard="${esc(p.key)}">Discard without inference</button></p>`).join('')}
      ${pending.length > 30 ? '<p>Showing the first 30 records. Refresh after discarding to see more.</p>' : ''}
      <div class="set-field"><label for="setInternalProvider">Exact configured provider ID</label><input id="setInternalProvider" value="${esc(s.provider || '')}" spellcheck="false">
      <label for="setInternalModel">Exact configured model ID</label><input id="setInternalModel" value="${esc(s.model || '')}" spellcheck="false">
      <label for="setProviderExtensions">Trusted extension paths for this provider</label>
      <textarea id="setProviderExtensions" rows="3" spellcheck="false">${esc((s.providerExtensions?.[s.provider] || []).join('\n'))}</textarea>
      <div class="set-help">One absolute file path per line. These execute trusted code. Only this provider’s explicit extensions load; ambient extensions remain disabled. A local model must be configured in Pi; selecting a model does not itself install or start it.</div>
      <button type="button" id="saveProviderExtensions">Use exact IDs and trusted paths</button></div>`;
  }
  function bind(root, { state, save, confirm, refresh, discard }) {
    root.querySelector('#setAiTitles').onchange = e => save({ aiTitles: e.target.checked });
    root.querySelector('#setMemoryImages').onchange = e => save({ memoryImages: e.target.checked });
    root.querySelector('#setAutomaticMemory').onchange = async e => {
      const mode = e.target.value;
      if (mode === 'changes-after-enable' && !confirm('Baseline sources now without inference? Future observed revisions will generate visible notes and memory using the selected model. Old context in resumed sessions is included.')) {
        e.target.value = state().settings.automaticMemory || 'legacy'; return;
      }
      await save({ automaticMemory: mode });
    };
    root.querySelector('#setInternalProvider').onchange = e => {
      root.querySelector('#setProviderExtensions').value = (state().settings.providerExtensions?.[e.target.value.trim()] || []).join('\n');
    };
    root.querySelector('#saveProviderExtensions').onclick = () => {
      const provider = root.querySelector('#setInternalProvider').value.trim(), model = root.querySelector('#setInternalModel').value.trim();
      if (!provider || !model || !confirm('Use ' + provider + '/' + model + ' and trust its listed extension entrypoints to execute code?')) return;
      const s = state().settings;
      const paths = root.querySelector('#setProviderExtensions').value.split('\n').map(s => s.trim()).filter(Boolean);
      save({ provider, model, usePiDefault: false, providerExtensions: { ...s.providerExtensions, [provider]: paths } });
    };
    root.querySelector('#refreshMemoryStatus').onclick = refresh;
    root.querySelectorAll('[data-memory-discard]').forEach(button => { button.onclick = () => {
      if (confirm('Discard this revision without inference? It will not be retried. A later observed change can qualify.')) discard(button.dataset.memoryDiscard);
    }; });
  }
  return { render, bind };
});
