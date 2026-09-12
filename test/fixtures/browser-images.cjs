'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
module.exports = function browserImages(root) {
  const page = path.join(root, 'images.html');
  fs.writeFileSync(page, `<!doctype html><pre id="result"></pre><script>
    const c=document.createElement('canvas');c.width=16;c.height=12;
    const x=c.getContext('2d');x.fillStyle='#a02060';x.fillRect(0,0,16,12);x.fillStyle='#10f050';x.fillRect(2,3,5,7);
    document.getElementById('result').textContent=JSON.stringify(['image/jpeg','image/png'].map(mimeType=>({type:'image',mimeType,data:c.toDataURL(mimeType,0.82).split(',')[1]})));
  </script>`);
  const html = execFileSync('chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--disable-extensions', '--user-data-dir=' + path.join(root, 'browser'), '--dump-dom', pathToFileURL(page).href], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(html.match(/<pre id="result">([^<]+)<\/pre>/)[1]);
};
