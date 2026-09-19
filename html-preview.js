import DOMPurify from '/vendor/dompurify/3.4.15/purify.mjs';

// Defense in depth: audited HTML sanitization, an opaque-origin iframe sandbox,
// and a CSP that permits only this preview's typed, folder-scoped asset URLs.
// Never attach the parsed document to the app DOM.
export function prepareHTML(source, assetBase) {
  const base = new URL(assetBase);
  if (base.origin !== location.origin || !/^\/api\/file\/preview-assets\/[a-f0-9]{64}\/$/.test(base.pathname) || base.search || base.hash) throw Error('Invalid preview asset location');
  const html = DOMPurify.sanitize(source, {
    WHOLE_DOCUMENT: true, RETURN_DOM: true, USE_PROFILES: { html: true },
    ADD_TAGS: ['link'], ADD_ATTR: ['rel'],
    FORBID_TAGS: ['script', 'base', 'meta', 'iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'template', 'noscript'],
    FORBID_ATTR: ['srcdoc', 'ping', 'action', 'formaction', 'target', 'autofocus', 'download', 'is', 'contenteditable', 'autoplay'],
  });
  for (const link of html.querySelectorAll('a,area')) {
    const href = link.getAttribute('href');
    if (href && !href.startsWith('#')) { link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true'); link.setAttribute('title', 'Links are disabled in this preview'); }
  }
  for (const link of html.querySelectorAll('link')) if (link.getAttribute('rel')?.toLowerCase() !== 'stylesheet') link.remove();
  for (const control of html.querySelectorAll('input,button,select,textarea')) control.setAttribute('disabled', '');
  for (const media of html.querySelectorAll('video,audio')) { media.setAttribute('controls', ''); media.setAttribute('preload', 'none'); }
  const doc = html.ownerDocument, head = html.querySelector('head');
  const csp = doc.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy';
  csp.content = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline' ${base.href}; img-src ${base.href} data:; font-src ${base.href} data:; media-src ${base.href}; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri ${base.href}`;
  const baseElement = doc.createElement('base'); baseElement.href = base.href;
  const referrer = doc.createElement('meta'); referrer.name = 'referrer'; referrer.content = 'no-referrer';
  const viewport = doc.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1';
  head.prepend(csp, baseElement, referrer, viewport);
  return '<!doctype html>\n' + html.outerHTML;
}
