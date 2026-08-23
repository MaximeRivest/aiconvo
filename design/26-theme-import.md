# Theme import: match aiconvo to your terminal or OS

Terminal color schemes and aiconvo tokens have the same shape: one
background, one foreground, and 16 ANSI colors. The importer maps them
mechanically and repairs contrast until the theme validator passes.

## Quick start

```bash
node themeimport.js            # auto-detect, write the theme, done
node themeimport.js --list     # show which color sources exist on this machine
```

The importer writes `~/.config/aiconvo/themes/<id>.css`. Open aiconvo,
focus the theme selector, and pick the theme under **custom themes**.

## Sources

Auto-detection tries these in order and uses the first complete one:

| Source | File |
|---|---|
| Omarchy / Hyprland theme | `~/.local/state/omarchy/current/theme/alacritty.toml` |
| pi custom theme | `~/.pi/agent/themes/<active>.json` (built-in dark/light carry no palette) |
| pywal / wallust | `~/.cache/wal/colors.json` |
| Alacritty | `~/.config/alacritty/alacritty.toml` (follows `import` chains) |
| Alacritty on Windows (WSL) | `/mnt/c/Users/<name>/AppData/Roaming/alacritty/alacritty.toml` |
| kitty | `~/.config/kitty/kitty.conf` (follows `include` lines) |
| Ghostty | `~/.config/ghostty/config` |
| foot | `~/.config/foot/foot.ini` |

Options:

```bash
node themeimport.js --from kitty                 # pick a detected source
node themeimport.js --from ~/some/theme.toml    # or read any palette file
node themeimport.js --id my-theme --name "My Theme"
node themeimport.js --print                     # stdout instead of a file
```

On Omarchy, the theme ID defaults to the current Omarchy theme name.
Re-run the importer after you switch Omarchy themes.

## How the mapping works

- `scheme` comes from the background lightness (dark or light).
- Surfaces and borders step from the background toward the foreground
  (4.5%, 9%, 14%, 19%, 32% mixes) — the same ramp the built-in themes use.
- Each app hue (red, yellow, green, cyan, blue, magenta) takes the normal
  or bright ANSI slot with the better contrast on the background.
- Any color below WCAG contrast gets its lightness moved away from the
  background until it passes (4.5:1 for text and hues, 3:1 for faint text).
  Hue and saturation stay, so the theme keeps its character.
- The 16 ANSI colors pass through unchanged for hosted terminal views.
- The terminal selection colors carry over when they are readable.
- Omarchy `colors.toml` `accent` and pi `vars.accent` become `--accent`
  and `--accent-strong`. `--green` stays the ANSI green.

## Agent prompt

Paste this into any coding agent to theme aiconvo from something the
importer does not cover (a VS Code theme, a wallpaper, a brand palette):

```text
Create a custom theme for aiconvo (the conversation browser).

1. Read design/25-themes.md in the aiconvo repo. It is the full file
   contract: metadata block, one :root[data-theme="<id>"] rule, and the
   required color tokens. Only custom-property declarations are allowed.
2. Extract my colors from <SOURCE>. I want the theme to feel like it.
3. If the source is a terminal palette (bg, fg, 16 ANSI colors), run
   `node themeimport.js --from <file>` instead of writing CSS by hand.
   Otherwise copy design/theme-template.css and fill every token.
4. Map colors by meaning, not by position: red stays for errors, yellow
   for warnings, green for success. Use the OS or brand accent for
   `--accent` when it is not green. Build the surface ramp as small steps
   from the background toward the foreground.
5. Validate: `node test/theme-check.js ~/.config/aiconvo/themes/<id>.css`
   Fix every reported error. Contrast failures: adjust lightness only.
6. Write the file to ~/.config/aiconvo/themes/<id>.css. Then reload
   aiconvo and select the theme in the header selector to verify it.
```

## Limits

- The importer produces `mode: color`, `motion: full` themes. For a
  binary or grayscale theme, edit the metadata and tokens by hand
  (see design/25-themes.md).
- VS Code themes need the agent path: their JSON has hundreds of keys
  and no fixed palette shape.
