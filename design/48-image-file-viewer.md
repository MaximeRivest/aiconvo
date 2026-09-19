# File viewers: images, videos, PDFs and HTML

## User experience

One file route chooses a viewer without changing navigation, project context,
Back, or the recent-files list. The binary viewers are read-only and offer
Reload and Download. They never mount a text editor or participate in saves.

- **Images:** PNG/JPEG/GIF/WebP/AVIF/BMP/ICO, Fit and scrollable Actual size,
  intrinsic dimensions. SVG remains editable XML source.
- **Videos:** MP4/M4V, WebM, OGV and MOV, using native controls, inline playback,
  seeking and fullscreen. No autoplay. Leaving stops playback and detaches the
  source. Unsupported codecs and damaged files show a recovery message.
- **PDFs:** bundled Mozilla PDF.js reader: page navigation, search, text selection,
  thumbnails, zoom and password prompts. No PDF JavaScript, annotation editing,
  interactive form editing, XFA, or background model downloads. Download delivers
  the original file, not an edited PDF. External links stay outside the app.
- **HTML:** Source / Preview on `.html` and `.htm`. Preview renders the current
  editor buffer and never itself writes to disk. The editor stays mounted, so
  selection, undo and its existing saving policy survive the switch. Shared
  editors keep autosaving as usual; explicit-save editors keep unsaved edits and
  recovery drafts. The notice states which policy is active. The route preserves
  Preview through refresh. Refresh preview takes a new snapshot and reloads its
  assets; it does not silently follow someone else's ongoing edits.

Touch controls are at least 44 CSS pixels. The player and reader scroll within
bounded viewports, including phone landscape. PDF.js uses its touch toolbar and
page-width default. On the e-ink theme its chrome is light, with animations off.
The actual PDF colors are preserved. Canvas rendering is capped at 8 megapixels
on touch/narrow screens (16 on desktop): extreme zoom may sacrifice sharpness
rather than allocate an unbounded canvas.

## Architecture

`filesmode.js` dispatches mounting/teardown. `live-file.js` provides shared
navigation, image viewing and the HTML toggle. `file-viewers.js` owns video/PDF
lifecycles and the HTML preview host. `file-viewers.css` supplies responsive
viewer layout without changing the editor's content styling.

### File bytes

`file-media.js` is the independent, tested delivery module. The authenticated
`GET|HEAD /api/file/media?path=…` route uses the canonical path resolver and
project visibility checks, then serves only explicitly allowed MIME types.
Images retain the 32 MiB cap. Videos and PDFs stream without a whole-file size
cap or server buffering. There is no compression of ranged bytes.

The open file descriptor is checked against the authorized device/inode and
file size. Responses support single byte ranges (closed, open and suffix),
206/416, Content-Length, Accept-Ranges, HEAD, ETag/If-None-Match and If-Range.
Unsupported multipart ranges are ignored and return a full 200 response, as
HTTP permits. Aborted clients close the disk stream. Download uses a safe
Content-Disposition including the Unicode filename. `nosniff`, private
revalidation and a restrictive CSP prevent files becoming active app pages.
The older image-content endpoints reuse this implementation but stay image-only.

These are **live files**, not frozen historical versions. Changing a file while
it is being read may require Reload. Native codec support varies by device;
there is deliberately no transcoding pipeline. Extension-based classification
matches the server's allowlist. Images still use whole-file browser blobs so
errors are readable; stale requests are aborted and blob URLs are released on
reload/navigation. The compressed byte cap cannot bound decoded pixel memory.

### PDF reader

`vendor/pdfjs/6.3.289` is the official **legacy** generic distribution, retaining
its viewer, accessibility, localization, fonts, CMaps and decoding resources.
Source maps, sample PDF, debugging tools and scripting sandbox are not shipped.
`pdf-viewer-config.js` configures the reader before startup, disables preferences
that could override the read-only/security policy, and communicates load/errors
to the outer file header. Its iframe is trusted bundled code; PDF content is
parsed by PDF.js, not injected as app HTML. The viewer's network CSP is tightened
to this server. Full-file auto-fetch/streaming are disabled in favor of range
loading. The reader's history cannot insert steps in the app's Back stack.
Download buttons and Ctrl+S use the outer authenticated original-file download,
including in Android WebView (which cannot hand blob URLs to DownloadManager).

The pinned bundle adds about 12 MB to the checkout, but is fetched only when PDFs
are opened and then uses the existing vendor cache. Documents themselves are
not cached by the service worker. No CDN or external viewer receives file data.
Use `python scripts/vendor-file-viewers.py` to reproduce both browser dependencies
from pinned, checksum-verified upstream archives. Preserve their licenses.

### HTML security and local resources

`html-preview.js` uses pinned DOMPurify 3.4.15, then creates an opaque-origin
iframe with an **empty sandbox permission list**. It removes scripts, active
embeds, meta refresh, supplied base tags, event handlers and non-fragment link
targets. Controls are disabled and media cannot autoplay. The first generated
head element is a CSP: no scripts, connections, frames, objects or forms;
styles, images, fonts and media can load only from that preview's asset URL.
External websites, scripts and non-fragment navigation remain disabled. This is
a visual preview, **not a running application or a replacement for a dev server**.

The browser sends only the HTML path to `POST /api/file/preview`; preview never
uploads the HTML buffer (a shared editor independently syncs it through its
normal collaboration channel). After canonical-path and visibility checks, the server
issues a random 256-bit capability scoped to the HTML file's containing folder.
`/api/file/preview-assets/<token>/…` serves only allowlisted CSS, images, fonts and
media. Relative CSS imports and resource URLs resolve normally. Traversal,
symlink escapes, HTML, scripts, arbitrary documents and directories are refused.
Assets are capped at 32 MiB each. Parent-folder and external assets intentionally
do not load; use a page whose assets are within its folder, or a separate dev
server when broader behavior is required.

This narrow asset route works without cookies because an opaque iframe has no
app credentials. Its token is a temporary bearer capability, not a public folder
URL. It has CORS for fonts, no-store/no-referrer, a 30-minute idle expiry and a
128-active-preview bound. The initiating sign-in proof is revalidated, together
with current project visibility, on **every asset request**, including nested
projects. Disabled/revoked users and sharing changes take effect immediately.
Source/navigation explicitly revoke the token; abrupt page exit relies on expiry.
An asset requested after expiry requires Refresh preview. The capability grants
no editor/API access and never widens the existing host path policy.

## Android app

The WebView supports native fullscreen video, Back-to-exit, restoration of system
bars, and pauses videos on backgrounding. Original-file downloads use Android's
DownloadManager with the existing sign-in cookie, **only** for the configured
server's `/api/file/media` route. Cookies are never forwarded to another origin.
Downloads go to public Downloads on Android 10+, app-specific Downloads on
Android 8/9; those older app-specific files are removed if the app is uninstalled.
Trusted HTTPS is recommended: DownloadManager does not inherit the WebView's
exception for private self-signed certificates. Embedded PDF attachment/blob
exports are not part of native downloading; the original PDF can be downloaded
and opened in another reader. PDF external links use the existing native browser
bridge; if no external handler exists, untrusted pages are not loaded into the
privileged WebView as a fallback.

These native changes require an APK update, not just a page refresh. Built with
JDK 17, Android platform/build tools 35 and Gradle 8.9. The shipped APK must use
the existing signing certificate so it upgrades without a reinstall/data reset.
The September 19 builds were signed on XPSwhite without copying private keys to
the build host. The tablet uses `~/.config/.android/debug.keystore` (certificate
SHA-256 starts `66715edc`), matching `aiconvo.apk`. The Samsung phone uses the
**different** `~/.android/debug.keystore` (starts `7d58ac15`). Its matching build
is `android/app/build/outputs/apk/phone/app-phone.apk`; the default APK does not
upgrade that phone. Check the installed certificate before choosing a key. Never
uninstall or clear data to work around a signature mismatch.

Physical phone testing also caught WebView's download callback omitting
Content-Disposition for `<a download>`. Native downloads now recover the original
Unicode filename from the authorized media URL rather than naming every file
`media.pdf` or `media.mp4`.

## Validation and release

- `test/image-view.test.js`: classification, fit/actual size, errors, reload,
  object-URL cleanup and navigation during download.
- `test/file-media.test.js`: real HTTP range/HEAD/cache/download behavior,
  identity and size rechecks, capability limits, traversal, symlinks and expiry.
- `test/file-viewers-browser.test.js`: isolated real server + headless Chromium,
  MP4/WebM playback and seeking, playback teardown, codec failure, phone portrait
  and landscape, PDF rendering/search/text/page/zoom/passwords/e-ink/errors,
  HTML explicit-save recovery and shared-autosave behavior, stale conversation
  navigation, nested local styles, images, blocked
  external requests/scripts/navigation, capability revocation and live sharing.
- Existing live-file, navigation, browser, recent-file, sidebar and theme tests.
- Android `assembleDebug`: compiled and both signing variants verified.
- **Physical phone verification, September 19:** upgraded the Samsung SM-G998W
  in place, using its matching certificate. Android 15, WebView 151.0.7922.199.
  Verified image Fit/Actual size; H.264 playback/seeking; native fullscreen and
  Back-to-exit; background pause; portrait/landscape bounds; PDF password prompt,
  search, page navigation and selectable text; HTML local CSS/images, opaque
  sandbox, blocked script and Source return. Downloaded the encrypted PDF through
  Android DownloadManager with its correct filename and checked its SHA-256
  against the server file. Fixed the phone's stale saved login and verified it
  reconnects after updating/relaunching. No app-data reset. Removed temporary
  test files/downloads and restored its portrait lock and home screen. No fatal
  app exceptions were seen in the check. The tablet remains physically untested;
  do not equate phone verification or device emulation with Safari/tablet testing.

Deploy the matching server and frontend together, then refresh clients. **Do not
restart Aiconvo while managed web agents are busy.** The new APK can be installed
independently once the web server is current. No Rust build, OS rebuild, conversion
service or runtime npm install is needed.
