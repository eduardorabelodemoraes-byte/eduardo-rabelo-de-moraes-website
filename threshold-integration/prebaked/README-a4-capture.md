# Canonical Home captures (Candidate A4)

`mv-home-desktop.png` and `mv-home-iphone.png` are one-time, offline
captures of the real, unmodified Home page's Expertise section (where the
"Game Localization" link lives), generated with Playwright against a local
static server — not html2canvas, and not part of the runtime page. They
replace the runtime, click-time html2canvas capture Candidates A1/A2/A3
used (`captureLiveHomeViewport()`), per phase-a1-integration.js's own
file-header comment.

Captured at:

- `mv-home-desktop.png` — 1366x800 CSS px, device scale factor 1
- `mv-home-iphone.png` — 390x844 CSS px, device scale factor 3

Both after scrolling `#expertise` into view (`scrollIntoView({block:
"start"})`) and a 200ms settle, matching this repo's existing local
validation harness (`a3-validation/run-scenarios.js`) viewport/scroll
conventions exactly, so the composition matches what the old live capture
always produced when a visitor's own scroll placed the link on screen.

To regenerate (e.g. if Home's Expertise section content changes): re-run
the equivalent of this capture procedure against the then-current
`index.html` and replace both files. There is no build step wired to do
this automatically — regeneration is manual and deliberate, matching this
candidate's "prevalidated" framing (a human should look at the new capture
before it replaces the shipped one).
