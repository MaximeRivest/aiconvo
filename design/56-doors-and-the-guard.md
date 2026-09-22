# The doors through Tailscale, and the guard in front of the sign-in

*2026-09-21. Builds on design/52 (invites), design/53 (walls), design/55
(limits). New: `frontdoor.js`, `authguard.js`. Changes in `server.js`
(pre-login block, `/api/doors*`, `/api/invites`), `settings.js`,
`people.js` (settings → machines block, the door choice in the invite
dialog), `app.html`. Tests: `frontdoor` (pure), `frontdoor-server` (a real
server: lockout, stale cookie, headers, owner-only doors). Machine side:
`os/machines/hosts/lambda/services.nix` names maxime the Tailscale
operator.*

## The question

A guest gets an invite link (design/52) and works behind walls (design/53)
with a budget (design/55). None of that answers *how the link reaches
them* when they are not on this network. Three doors exist, and the demo
needs two of them offered from the same dialog, with the trade-off of
each said in words.

## The doors

All three share one https name — `https://lambda.tail69222b.ts.net` — and
one handler in tailscaled's state (port 443, proxied to Chattering). What
differs is who may reach the name.

- **Your network** (what existed): the LAN address, plus the tailnet
  name for your own devices. Nothing to do.
- **The tailnet door** (Serve): the name is reachable by every device on
  the tailnet. A guest can use it if they have Tailscale and *this
  machine* is shared with them. Tailscale's API mints a **device invite**
  — a single-use link that shares this one device with the person who
  accepts it, nothing else of the tailnet. The invite dialog offers this
  when an API access token is saved in settings → machines; the two
  links (the share, then the Chattering link) come out together. Traffic is
  direct, machine to machine, relayed encrypted only when punching fails;
  nothing about Chattering is on the public internet. The price: the person
  installs Tailscale and signs in with a Google/GitHub/Apple account. Two
  minutes, free, once.
- **The public door** (Funnel): the same name, opened to the internet.
  Nothing to install on their side. The price: Chattering's sign-in page is
  on the internet while the door is open, and Chattering's own gate is the
  only gate — which is why the guard below exists, and why the walls came
  first. A switch on settings → machines, owner only, with a confirm;
  turning it off re-declares the *serve* handler (which clears the funnel
  bit) rather than removing it, because a removal would take the
  everyday tailnet door down with it.

The invite dialog shows only the doors that are open right now, with a
hint under each saying what the person on the other side must have. The
Chattering link is the same credential whichever door it arrives by.

Tailscale itself gates two things: Funnel must be enabled once on the
tailnet (an admin click; the refusal carries the link and the settings
page shows it), and the service user must be the Tailscale operator
(`tailscale set --operator=maxime`, now in lambda's NixOS config) — the
refusal says that too.

## The guard

With a door on the internet, the sign-in page will be visited by scanners
within the hour. Chattering's credentials are 128-bit random tokens; guessing
one is hopeless. The guard exists so that nobody has to trust that
sentence, and so that the owner can *see* what is happening.

- **A limiter on failed proofs, per address.** Ten distinct wrong secrets
  in fifteen minutes lock that address out for the rest of the window —
  including the right secret, because the lock is on the address and that
  is the point. A success clears its own address. A bare visit to the
  page costs nothing. The same wrong secret presented again is one guess,
  not a dozen: a browser with a stale cookie sends it on every request of
  a page load, and locking out the real person before they can type the
  right token would be the guard defeating its purpose. The stale cookie
  is also cleared on the 401 so the browser stops presenting it. Across
  all addresses, three hundred failures in the window add a small delay
  to every attempt rather than a lock: a person on a busy network is
  never locked out by strangers.
- **The address is the first forwarded hop** when the connection comes
  from loopback (Serve and Funnel proxy from there), else the socket. A
  direct connection that forges the header only chooses which bucket it
  fills.
- **A log of every outcome** — time, address, door (local, lan, tailnet,
  public), outcome, who, how — appended to
  `~/.local/share/chattering/sign-ins.jsonl`, outside the cache, bounded in
  memory. Settings → machines → "recent sign-ins" shows the tail; opening
  and closing the public door is logged there too.
- **Headers on every answer**: `X-Frame-Options: SAMEORIGIN` (the app
  frames only itself; HTML previews are sandboxed same-origin),
  `Referrer-Policy: no-referrer` (a token that was in a URL must never
  travel in a Referer), `X-Content-Type-Options: nosniff`, and behind
  https `Strict-Transport-Security`. The cookie is `Secure` behind https
  (Serve and Funnel say so with `X-Forwarded-Proto`), never over plain
  http on the LAN, or it would not come back.

## The plain-words page

`/guests` — public, before any sign-in, linked from the invite landing and
from the invite dialog — says what a guest can, cannot, and what the
owner can, in words a person reads once and can hold the owner to. It
names nothing on the machine. It also says what this is *not*: walls
between people who share a computer, not a hosting service.

## The machine side (NixOS)

`os/machines/modules/chattering.nix` (`services.chattering.frontDoor.*`): the
LAN ports, bubblewrap, the Tailscale Serve unit for the tailnet name, and
the operator right. Both hosts use it. The serve unit re-declares the
tailnet-only handler at every boot, so **a reboot closes the public
door** on purpose; its stop is a no-op so a rebuild never takes the
everyday door down for the seconds in between.

## Trade-offs, stated

- **Tailscale, not a self-hosted relay.** Both doors depend on Tailscale's
  ingress and, for the tailnet door, on their API. The alternative that
  removes the dependency — a browser-to-machine WebRTC channel with a tiny
  rendezvous — is the long-game service and weeks of work; recorded, not
  built.
- **Funnel means Tailscale's ingress sees the encrypted stream**, not the
  plaintext (TLS terminates on this machine). A Cloudflare Tunnel would
  add an identity wall in front but would terminate TLS at Cloudflare;
  end-to-end won.
- **The lock is on the address, so a shared NAT** (an office, a campus)
  shares the lock. Fifteen minutes, ten guesses: the owner would have to
  mistype a token ten times in a row from that network to notice.
- **The API access token is a secret held in settings**, visible to the
  owner and admins (like machine tokens), never to members, never to
  guests. It can only mint device invites, not read the tailnet; scope it
  to `devices` when making it.
- **No second factor.** A token is the credential. If the demo were to
  become a product, a passkey on the sign-in page is the next step; the
  log and the limiter are what make that a next step rather than a
  prerequisite.
- **The operator preference is machine configuration** (NixOS here),
  applied at the next rebuild — the switch refuses in words until then.
