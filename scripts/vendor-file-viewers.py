#!/usr/bin/env python3
"""Reproduce the pinned PDF.js and DOMPurify bundles (standard library only)."""
import hashlib
import io
from pathlib import Path
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PDF_VERSION = '6.3.289'
PURIFY_VERSION = '3.4.15'


def download(url, sha256):
    data = urllib.request.urlopen(url).read()
    if hashlib.sha256(data).hexdigest() != sha256:
        raise RuntimeError('Checksum mismatch: ' + url)
    return data


def main():
    data = download(f'https://github.com/mozilla/pdf.js/releases/download/v{PDF_VERSION}/pdfjs-{PDF_VERSION}-legacy-dist.zip',
                    '51683fac4aff7dd31ed91e9ab735a2098a78d50899d1ec529aed6dc8aa19400d')
    dest = ROOT / 'vendor/pdfjs' / PDF_VERSION
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for item in archive.infolist():
            name = item.filename
            if item.is_dir() or name.endswith('.map') or 'pdf.sandbox.' in name or name.startswith('web/debugger.') or name.endswith('.pdf'):
                continue
            out = dest / name
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(archive.read(item))
    # Keep the upstream viewer and its accessibility intact. Only replace its
    # bootstrap, tighten network access and permit browser magnification.
    html = dest / 'web/viewer.html'
    text = html.read_text().replace(', maximum-scale=1', '')
    text = text.replace('connect-src * blob: data:', "connect-src 'self' blob: data:")
    text = text.replace('<script src="viewer.mjs" type="module"></script>',
                        '<script src="/pdf-viewer-config.js" type="module"></script>\n<link rel="stylesheet" href="/pdf-viewer.css" />')
    html.write_text(text)
    data = download(f'https://registry.npmjs.org/dompurify/-/dompurify-{PURIFY_VERSION}.tgz',
                    '4f5d49223fa056790019d990e5e4207166a86ac13d9ec8c73d828c63d75b34b5')
    dest = ROOT / 'vendor/dompurify' / PURIFY_VERSION
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for src, name in [('package/dist/purify.es.mjs', 'purify.mjs'), ('package/LICENSE', 'LICENSE')]:
            (dest / name).write_bytes(archive.extractfile(src).read())
    print('Vendored PDF.js', PDF_VERSION, 'and DOMPurify', PURIFY_VERSION)


if __name__ == '__main__':
    main()
