# Links and diagrams: a walk-through

Open this file in Chattering (Files → this folder → README.md, or paste
`#file&focus&path=/home/maxime/Projects/chattering/manual-test/links-and-diagrams/README.md`
after the `/#` in the address bar). Then follow the numbered steps in order;
each one says what you should see.

## 1. A link to another document

Click [the design decision](adr/0001-links.md). It should open in this same
screen, and **Back** (the ← button, or the browser's back) should return here.

## 2. A link to a specific line

Click [line 17 of the decision](adr/0001-links.md#L17). The editor should land
on line 17 (the line that says "you asked for line 17"). Now **reload the
page**: the address keeps `line=14` and you land there again.

## 3. A link to a heading

Click [the "Consequences" heading](adr/0001-links.md#consequences). The editor
should scroll to that heading. A heading that does not exist,
[this one](adr/0001-links.md#no-such-heading), still opens the file but shows
a toast: "heading not found".

## 4. Back returns to where you were, not to the link's line

Click [line 17 again](adr/0001-links.md#L17), then scroll down and click
somewhere near the bottom of that file, then follow its link back here, then
press **back**. You should land near the bottom, where your cursor was, not
on line 17.

## 5. Going up a folder

Click [the notes index](../links-and-diagrams/notes/index.md). `../` resolves
against this file's folder; the link works.

## 6. A dead link and a folder link

[This file does not exist](adr/0009-missing.md): a toast says "link target
not found", and you stay here. [This is a folder](adr): it opens the Files
browser at that folder, from any device (laptop, phone), and back returns
here.

## 7. Ctrl-click (Cmd on a Mac)

Ctrl-click [the decision](adr/0001-links.md). It should open in your system
application, not in Chattering (on lambda's own browser only; a remote browser
gets a toast saying system actions are laptop-only).

## 8. A space and a percent in the file name

[A file with a space](notes/my%20notes.md) and [one with a percent](notes/50%_done.md)
both open.

## 9. Links pasted by agents (`#/` form)

Paste this in the address bar, after the host:

    /#/file&focus&path=/home/maxime/Projects/chattering/manual-test/links-and-diagrams/notes/index.md

It opens the notes index. Before, the leading slash made it a dead link.
Press back once: one step returns here, not two.

## 10. Diagrams

Go to [diagrams.md](diagrams.md).
