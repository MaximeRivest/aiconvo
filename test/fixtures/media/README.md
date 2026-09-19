# Media test fixtures

Synthetic, generated files; no recordings or personal documents.

- `clip.webm`: three seconds of FFmpeg's `testsrc2`, VP8, no audio.
- `clip.mp4`: the same sample encoded as H.264, yuv420p, fast-start.
- `password.pdf`: `samplePDF()` from `test/helpers/viewer-browser.js`, encrypted
  with qpdf. The public fixture passwords are `reader-password` and
  `owner-password` (owner).

Regenerate from the repository root:

```sh
ffmpeg -f lavfi -i 'testsrc2=size=320x180:rate=10:duration=3' -c:v libvpx -b:v 100k -an -y test/fixtures/media/clip.webm
ffmpeg -f lavfi -i 'testsrc2=size=320x180:rate=10:duration=3' -c:v libx264 -pix_fmt yuv420p -preset fast -crf 35 -movflags +faststart -an -y test/fixtures/media/clip.mp4
node -e "require('fs').writeFileSync('/tmp/viewer-source.pdf',require('./test/helpers/viewer-browser').samplePDF())"
qpdf --encrypt reader-password owner-password 256 -- /tmp/viewer-source.pdf test/fixtures/media/password.pdf
```
