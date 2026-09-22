# Vendored: yjs for the server

`13.6.29/yjs-server.cjs` is Yjs 13.6.29, y-protocols 1.0.7 (sync and
awareness) and lib0's encoding/decoding, built as one CommonJS file for
the Node host. `collab.js` uses it to hold the shared documents (compose
boxes, files) and to speak the y-websocket wire protocol over
`wsserver.js`. Chattering keeps no npm dependencies; this is vendored like
the editor bundle.

Build (from the mrmd editor checkout, which owns the toolchain):

```bash
cd ~/Projects/mrmd-packages/mrmd-editor
npx rollup -c rollup.yjs-server.config.js
cp dist/yjs-server.cjs ~/Projects/chattering/vendor/yjs-server/<version>/
```

The browser side of the same protocol (Y.Doc, WebsocketProvider,
awareness, the CodeMirror binding) ships inside the mrmd-document bundle
from 0.12.0 on, under `mrmdDocument.collab`.

License: MIT (Kevin Jahns), in `LICENSE`.
