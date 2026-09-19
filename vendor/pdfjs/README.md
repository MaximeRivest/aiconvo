# PDF.js 6.3.289

Official Mozilla legacy generic distribution, Apache-2.0 (see `6.3.289/LICENSE`
and the retained font/resource licenses).

Source: https://github.com/mozilla/pdf.js/releases/tag/v6.3.289
Archive: `pdfjs-6.3.289-legacy-dist.zip`
SHA-256: `51683fac4aff7dd31ed91e9ab735a2098a78d50899d1ec529aed6dc8aa19400d`

Reproduce using `python scripts/vendor-file-viewers.py` from the repository root.
The script excludes source maps, sample documents, debugger and scripting sandbox.
It patches only `web/viewer.html`: delegates bootstrap to
`/pdf-viewer-config.js`, adds `/pdf-viewer.css`, permits browser magnification,
and tightens connect-src to this origin. Reader code is otherwise upstream.

When upgrading, audit new defaults in AppOptions, verify the bootstrap hook and
CSP, then run the media browser tests (including passwords and malicious HTML).
Do not silently enable scripting, editors, model downloads, cross-origin network
access, or preferences that override the embedded viewer's policy.
