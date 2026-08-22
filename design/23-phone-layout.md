# Phone layout

A phone is a reading and response surface, not a scaled timeline workstation.
Desktop and e-ink layouts keep their existing behavior.

## Device policy

- Android detects iFLYTEK/XF-T5 hardware and keeps the binary e-ink theme.
- Android phones honor the viewport meta tag and use light/system color.
- Browser phone mode activates below 700 CSS pixels, including short coarse-pointer landscape screens.

## Home

- Four recent projects appear first.
- Remaining projects stay in a collapsed **all projects** section.
- Recent conversations follow on the first screen.
- Conversation, note, epic, and repository tabs form a fixed bottom bar.
- The desktop Gantt remains available on larger screens.

## Reading and response

- The header becomes one compact row. Search appears only at home.
- The `⧉` window button stays next to the brand. The overview is full-screen with one card per row.
- Breadcrumbs scroll horizontally.
- Transcript text uses a 15-pixel base and full-width message cards.
- The composer stays at the bottom with large attach, microphone, and send controls.
- The desktop **continue in Alacritty** escape hatch is hidden. Live view remains available.

## Projects and files

- Project actions use a two-column touch grid.
- Project trees use full-width search and large rows.
- Focused files switch between **files** and **compare** modes.
- Changed old/new blocks stack vertically.
- File timeline controls remain touch-sized and horizontally scroll when necessary.

## Constraints

- Never force the e-ink theme on a normal Android phone.
- Never shrink the full desktop Gantt to fit a phone.
- Keep all existing hashes, routes, APIs, and desktop behavior.
