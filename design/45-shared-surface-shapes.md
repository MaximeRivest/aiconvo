# 45 — Shape is a shared contract, not a handful of decorated components

## What was missing

The first pass introduced radius tokens but connected only the composer and a
few menus. Conversation previews, filters, machine selection, generic dialogs,
project/mode forms and file/review controls still used missing or fixed radii.
Changing a theme could not change the interface consistently.

## Contract

`design/tokens.css` owns the values; `design/surfaces.css` owns surface families.
The latter loads with the app and is served as `/surfaces.css` (no-cache).

| Token | Default | Use |
|---|---:|---|
| `--roundness` | 1 | Scale for all default decorative radii; 0 is square |
| `--r` | 6px × scale | Controls and cards |
| `--r-sm` | 4px × scale | Small controls and menu actions |
| `--r-menu` | 10px × scale | Menus, pickers, previews, editor tooltips |
| `--r-dialog` | 14px × scale | Modal cards and native dialogs |
| `--r-composer` | 18px × scale | Composer |
| `--r-pill` | 999px × scale | Chips and segmented scope controls |
| `--panel-r` | `--r-menu` | Agent tray compatibility alias |
| `--panel-row-r` | `--r` | Sidebar-row compatibility alias |

A theme can set **only `--roundness: 0`** to square off every default decorative
surface, including the sidebar. Built-in e-ink does exactly that. A fractional
scale is supported. Existing themes with explicit semantic radius overrides
keep those overrides; the scale does not silently override a theme's own CSS.
The theme template now demonstrates the scale instead of fixing four radii.

## Wiring

- New surfaces use `.ui-menu`, `.ui-dialog`, `.ui-card`, `.ui-pill`, or
  `.ui-control`. Native `dialog` and semantic dialog/menu roles get sensible
  defaults automatically. Do not put rounding on a full-screen backdrop.
- Existing selectors are adapters in the shared sheet. There is no need to
  rewrite every dynamic renderer or change its click/keyboard behavior.
- The defaults use low specificity; component-specific shapes, native
  integrations and custom themes can override them without `!important`.
- Component-specific decorative sizes use tokens, never pixel literals.
  Joined table/tab edges, timeline cells/graph markers, full-screen surfaces,
  radio indicators and status circles remain intentional structural shapes.
- Browser/OS-owned dialogs and vendor-rendered text frames are not CSS surfaces
  owned by aiconvo. The app's editor tooltips and extension-view shell do follow
  the tokens; the contents retain their own meaning/layout.

## Painted edges, focus and scrolling

Rounded outer borders alone are insufficient when children paint square
backgrounds across them. The model picker, extension-view shell, machine and
file-action menus clip their painted edges; their internal list/screen remains
the scroll container. Other scrollable popups already clip with overflow auto.

Do not set overflow hidden on every dialog or card: that cuts off nested menus
and focus rings. Padded menus keep content inset; cards keep overflow visible.
Search/card headers round only their exposed corners. A native `details`
summary can inherit from its internal slot rather than the styled details
host, so summaries explicitly use the card token, inset by the border width.

## Verification

`test/surfaces.test.js`:

- Rejects fixed decorative radii in app styles and every top-level component
  stylesheet. Structural exceptions are kept explicit.
- Flags new floating bordered surfaces missing a shape contract.
- Opens the real conversation preview, search dialog and merge dialog with a
  nested model picker; checks the served stylesheet and actual computed radii.
- Renders specimens for all surface families with production CSS, including
  editor/file/review panels, generic opt-in classes, and native dialog/menu
  semantics. Switches light/dark/e-ink, square/half-round, and independent menu
  and dialog overrides, at desktop and phone widths.
- Checks child-corner hit testing, list scrolling, and unclipped card overflow.
  Saves preview and gallery screenshots in `/tmp/theme-*.png` for inspection.

Existing conversation-app, sidebar, navigation and theme suites remain the
functional regression checks; this is a shape migration, not a navigation or
control-behavior redesign.
