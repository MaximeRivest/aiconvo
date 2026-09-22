# 61 — Chattering, by Rockfrog

*2026-09-22. The product's name changes from aiconvo to Chattering. This note records what the name is, where the brand appears, and what the rename must never break.*

## The name

- **Chattering** is the product: the workspace, the command (`chattering`), the service (`chattering.service`), the data folders, the Pi tools (`chattering_search` …).
- **Rockfrog** is the maker: the domain (`rockfrog.ai`, bought 2026-09-22 for two years), the Android package (`app.rockfrog.chattering`), and the credit line "by Rockfrog".
- The pair comes from a real animal, the *chattering rock frog* (`Litoria staccato`), found by searching iNaturalist for animal names that contain "chat". The frog is the mascot; the logo direction is a small frog on an open page (design work in `~/Pictures/rockfrog-concepts`).

Why not the old name: *aiconvo* named the category (AI conversations) and the first version of the product (a conversation browser). The product is now a place to think and to work with agents — files, reviews, memory, delegation, several people, several devices — and a category name cannot grow past its description. "AI" in a name also dates instantly.

## Where the brand appears

"Chattering" everywhere a person reads the product's name. "by Rockfrog" only where a maker's credit belongs: the sign-in page, the bottom of the settings navigation (a link to rockfrog.ai), the app manifest description, the README, the Android setup screen, the desktop launcher's comment. Not on every screen, not in the header.

In prose the name is capitalised (Chattering); as a command, a path, an identifier or a service it is lowercase (`chattering`). Old records and old transcripts keep saying "aiconvo": they are records of what was said at the time.

## What the rename must not break

Everything already written carries the old name inside it. None of it is rewritten; all of it is still read.

| Where the old name lives | What happens |
|---|---|
| Session files: `aiconvo-author`, `aiconvo-speed` custom entries; the `aiconvo` operation field; `aiconvoRewrite` | read as their new-name twins; new writes use the new name only |
| Message markers `<!-- aiconvo:merge -->`, `:both`, `:regenerate`, `:operation` | same: both spellings parse, new markers say `chattering:` |
| The project marker `.aiconvo/project.json` in checkouts (also in other people's clones) | read when `.chattering/project.json` is absent; an explicit write (invite, join) writes the new folder |
| Custom theme files with `/* aiconvo-theme` | both headers parse |
| `~/.cache/aiconvo`, `~/.config/aiconvo`, `~/.local/share/aiconvo`, `~/notes/aiconvo` | moved once to the new name on first start (`legacy-homes.js`), never over an existing destination |
| Browser storage keys `aiconvo.*` | copied to `chattering.*` on page load, then deleted |
| The Android app built before the rename (`app.aiconvo`) | the page aliases the old bridge names until every device runs the new build; that block in `app.html` is marked for deletion |
| The checkout itself (`~/Projects/aiconvo`) and the records that name this project by its folder | `scripts/finish-rename.sh`: moves the folder, folds `aiconvo` into `chattering` (project folds, `projectfolds.js`), moves the project memory to the new slug, keeps the project id |

`test/legacy-names.test.js` pins the reading half of this table.

## Trade-offs taken

- **No aliases.** There is no `aiconvo` command, tool or service left. Older AI-written notes that say `aiconvo search …` are wrong from now on; `~/.pi/agent/AGENTS.md` tells agents to read `chattering` wherever they see `aiconvo`.
- **Design docs were renamed too**, so they read as if the product had always been called Chattering. The history of the name is this note.
- **The Android package changes**, so phones and the e-ink tablet see a new app: one token entry per device, and the old app is uninstalled by hand. The APK is built on the laptop (Android SDK); lambda has none.
- **The last step stops the server.** It is a script run by a person, because the conversation that made the rename was itself hosted by the server being renamed.
