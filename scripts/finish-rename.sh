#!/usr/bin/env bash
# The last step of the rename from aiconvo to Chattering (2026-09-22), run
# by hand because it stops the server — the one that hosts the conversation
# in which the rename was made. Everything before this step is in the
# repositories (this one and ~/Projects/os/machines) and does not touch a
# running machine. Idempotent: run it again if a step fails.
#
#   ~/Projects/aiconvo/scripts/finish-rename.sh
#
# What it does, in order:
#   1. stops the old user service
#   2. moves the checkout: ~/Projects/aiconvo → ~/Projects/chattering
#   3. moves the semantic search folder under ~/family-ai
#   4. moves the data folders (~/.cache, ~/.config, ~/.local/share, ~/notes)
#   5. rewrites the records that name this project by its folder
#   6. points the `chattering` command at the new checkout
#   7. rebuilds Home Manager (installs chattering.service) and NixOS
#      (the semantic service, the Tailscale front door unit)
#   8. starts the new service and waits for it to answer
set -euo pipefail

OLD="$HOME/Projects/aiconvo"
NEW="$HOME/Projects/chattering"
HOST="$(hostname)"

say() { printf '\n== %s\n' "$*"; }

say "1. stop every server, old name or new"
# Both names: on lambda a chattering.service installed by an earlier
# Home Manager switch ran next to aiconvo.service for 13 minutes, and
# the data folders were then "already there" under the new name.
for u in aiconvo.service aiconvo-idle-stop.timer chattering.service chattering-idle-stop.timer; do
  systemctl --user stop "$u" 2>/dev/null || true
done
# The hand-written units the Nix module replaced (the laptop had them
# linked from ~/.config/systemd/user). Nix owns the unit from now on.
for u in aiconvo.service aiconvo-idle-stop.service aiconvo-idle-stop.timer; do
  systemctl --user disable "$u" 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/$u"; rm -rf "$HOME/.config/systemd/user/$u.d"
done
rm -f "$HOME/.config/autostart/aiconvo-tray.desktop"
systemctl --user daemon-reload
if pgrep -f "Projects/(aiconvo|chattering)/server.js" >/dev/null; then
  echo "a server is still running:" >&2; pgrep -af "Projects/(aiconvo|chattering)/server.js" >&2
  echo "stop it, then run this script again" >&2; exit 1
fi

say "2. move the checkout"
if [ -d "$OLD" ] && [ ! -e "$NEW" ]; then mv "$OLD" "$NEW"; echo "moved $OLD → $NEW"
elif [ -d "$NEW" ]; then echo "already at $NEW"
else echo "no checkout at $OLD or $NEW" >&2; exit 1; fi
# The GitHub repository was renamed too; the old URL only redirects.
remote=$(git -C "$NEW" remote get-url origin 2>/dev/null || true)
case "$remote" in
  *MaximeRivest/aiconvo*) git -C "$NEW" remote set-url origin "${remote/aiconvo/chattering}"; echo "origin → $(git -C "$NEW" remote get-url origin)" ;;
esac
# Worktrees of this checkout (~/Projects/aiconvo-links) point at the old
# .git path; repair rewrites both sides.
git -C "$NEW" worktree repair 2>/dev/null || true
git -C "$NEW" worktree repair "$HOME"/Projects/aiconvo-* 2>/dev/null || true

say "3. move the semantic search folder"
if [ -d "$HOME/family-ai/aiconvo-semantic" ] && [ ! -e "$HOME/family-ai/chattering-semantic" ]; then
  mv "$HOME/family-ai/aiconvo-semantic" "$HOME/family-ai/chattering-semantic"; echo "moved"
else echo "nothing to move"; fi

say "4. move the data folders"
# A skip here means data under the old name would be left behind: stop
# and let a person merge, rather than start a server over half the data.
node -e "
const r = require('$NEW/legacy-homes.js').migrateHome(require('os').homedir(), { log: console.log });
if (r.skipped.length) { console.error('data folders not moved: merge them by hand before going on'); process.exit(1); }
"

say "5. records that name this project by its folder"
node - "$NEW" <<'EOF'
const fs = require('fs'); const path = require('path'); const os = require('os');
const NEW = process.argv[2];
const notes = path.join(os.homedir(), 'notes', 'chattering');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
// The project's own marker: same id, new name.
const marker = path.join(NEW, '.chattering', 'project.json');
const m = readJson(marker);
if (m && m.name !== 'chattering') { m.name = 'chattering'; m.note = 'Chattering project id: keeps conversations, memory and invites of this project aligned across machines. Commit this file.'; writeJson(marker, m); console.log('marker renamed'); }
// The id registry: the record for this checkout follows the folder.
const idsFile = path.join(notes, 'projects', 'ids.json');
const ids = readJson(idsFile);
if (ids && ids.projects) {
  let n = 0;
  for (const rec of Object.values(ids.projects)) if (rec.name === 'aiconvo' || rec.cwd === path.join(os.homedir(), 'Projects', 'aiconvo')) { rec.name = 'chattering'; rec.cwd = NEW; n++; }
  if (n) { writeJson(idsFile, ids); console.log('ids.json:', n, 'record(s) renamed'); }
}
// Old conversations were recorded under the old folder name; the fold
// makes them the same project as the new ones.
const aliasesFile = path.join(notes, 'projects', 'aliases.json');
const aliases = readJson(aliasesFile) || { aliases: {}, dismissed: [] };
if (aliases.aliases.aiconvo !== 'chattering') { aliases.aliases.aiconvo = 'chattering'; writeJson(aliasesFile, aliases); console.log('fold added: aiconvo → chattering'); }
// Project memory (intent.md carries human words): moved to the new slug.
const crypto = require('crypto');
const slug = name => name + '-' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
const from = path.join(notes, 'projects', slug('aiconvo')), to = path.join(notes, 'projects', slug('chattering'));
if (fs.existsSync(from) && !fs.existsSync(to)) { fs.renameSync(from, to); console.log('memory moved:', path.basename(from), '→', path.basename(to)); }
// Titles and per-project files keyed by the old name.
for (const file of ['project-titles.json', 'projects.json']) {
  const f = path.join(notes, file); const d = readJson(f);
  if (d && d.aiconvo && !d.chattering) { d.chattering = d.aiconvo; delete d.aiconvo; if (d.chattering.cwd) d.chattering.cwd = NEW; writeJson(f, d); console.log(file + ': key renamed'); }
}
EOF

say "6. the chattering command"
mkdir -p "$HOME/.local/bin"
ln -sfn "$NEW/chattering" "$HOME/.local/bin/chattering"
rm -f "$HOME/.local/bin/aiconvo"
chmod +x "$NEW/chattering"
echo "installed: ~/.local/bin/chattering"

say "7. rebuild this machine (Home Manager, then NixOS — the second asks for sudo)"
# The flake names the laptop's home "maxime" and lambda's "maxime@lambda".
HM_ATTR=maxime; [ "$HOST" = lambda ] && HM_ATTR=maxime@lambda
home-manager switch --flake "$HOME/Projects/os/machines#$HM_ATTR"
sudo nixos-rebuild switch --flake "$HOME/Projects/os/machines#$HOST"

say "8. start Chattering"
# A portal machine (the laptop: desktop.chattering.autostart = false) has
# no [Install] section; there the launcher starts the server on demand
# and the service is left alone.
if [ -z "$(systemctl --user show -p WantedBy --value chattering.service 2>/dev/null)" ]; then
  echo "portal machine: chattering.service starts on demand, not now"
else
  systemctl --user enable --now chattering.service
  for i in $(seq 1 60); do
    if curl -fs -o /dev/null http://localhost:7433/health; then echo "Chattering answers on http://localhost:7433"; break; fi
    sleep 1
    if [ "$i" = 60 ]; then echo "no answer after 60 s: journalctl --user -u chattering -n 50" >&2; exit 1; fi
  done
fi

say "done"
echo "Remaining by hand: the phone and the e-ink tablet need the rebuilt APK (android/) — until then they keep working through the old app."
