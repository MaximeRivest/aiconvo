# Slides in Chattering

A deck is a folder in the project. Chattering shows it in the artifact panel
with thumbnails, present mode (full screen) and printing to PDF, one slide
per page. Each slide is its own small HTML file, so you can rewrite one slide
without touching the others, and each version stays with the conversation.

## Files

```
talk/
  deck.json
  slides/
    cover.html
    problem.html
    …
  images/…        (optional: pictures, referenced as images/x.png)
```

`deck.json`:

```json
{
  "title": "The chattering rock frog",
  "slides": ["cover", "problem", "habitat", "call", "sources"],
  "fonts": ["https://fonts.googleapis.com/css2?family=Fraunces:wght@300..700&family=Inter:wght@400;600&display=swap"],
  "background": "#f4ece2"
}
```

- `slides`: the order; each id is `slides/<id>.html`.
- `fonts` (optional): stylesheet links loaded once for the whole deck.
- `background` (optional): the colour around and behind slides.
- `size` (optional): `[1920, 1080]` is the default; every slide is designed
  at exactly this size and scaled to fit the screen.

A slide file is one `<section>` with inline styles (no `<html>`, no
`<head>`). Asset paths are relative to the deck folder (`images/frog.jpg`).

```html
<section style="background:#2a1a14; color:#f4ece2; padding:128px; display:flex; flex-direction:column; justify-content:center; gap:48px; font-family:Inter, sans-serif">
  <h1 style="font-family:Fraunces, serif; font-size:120px; font-weight:400; line-height:1.05; margin:0">The chattering rock frog</h1>
  <p style="font-size:40px; margin:0; opacity:.8">Litoria staccato · Kimberley, Western Australia</p>
  <aside class="notes">Speaker notes: shown under the slide in the panel, never on the slide.</aside>
</section>
```

## Design

- Design for 1920 × 1080: generous padding (96–128 px), body text 32–40 px,
  titles 72–120 px. One idea per slide. Few words.
- Pick two fonts at most and one accent colour; keep them on every slide.
- Use real layout (flex, grid). No absolutely positioned text that overflows.
- Images: put files in the deck folder and reference them relatively. Credit
  sources on a final slide.
- Scripts inside slides do not run; a slide is a still picture with text.

## Then

Call the `artifact` tool with the deck folder (type `slides`). If you have
`agent_browser`, open the returned address and look at every slide before you
answer: overflowing text and unreadable contrast are the usual mistakes.
