// Games Pre-bake Pipeline — Stable Games V8 canonical handoff anchor
// (isolated tooling; re-created on validation/stable-games-v8)
//
// History note: an earlier version of this tool (introduced at
// "tools: preserve Games pre-bake validation pipeline", removed at
// "retire Home Threshold integration") targeted the OLD game-localization
// design (the `prologue-line-in` CSS keyframe reveal, gated by
// `.experience-failsafe`/`.experience-started`). That design no longer
// exists — V8 replaced it with `revealObserver`/`revealNarr()` (desktop,
// IntersectionObserver + CSS transition) and `mobileRevealLoop()`/
// `animateMobileNarr()` (mobile, requestAnimationFrame + WAAPI
// `el.animate()`). This version targets that real, current mechanism.
//
// Purpose: render the REAL, current, unmodified game-localization/index.html
// (this repo's own tracked file) at the two canonical viewports the
// Crossing/Arrival material engine already samples as a static texture,
// and save a byte-for-byte deterministic capture of the page's own
// canonical "handoff anchor" state:
//
//   - #world / #trail / #side-nav / #mobile-chapter: fully present, in
//     their normal (non-suppressed) state — i.e. exactly what
//     `experience-started` alone already produces, with no additional
//     handoff-only fade layered on top.
//   - .narr (all indices): pre-reveal — opacity 0, base transform — i.e.
//     the state that exists before `revealObserver`/`mobileRevealLoop`
//     have been allowed to progress even one frame. This is what makes
//     the captured texture and the live page's own first paint agree, so
//     the page's existing, unmodified reveal-in plays exactly once,
//     visibly, after navigation — instead of the texture depicting
//     already-revealed text that the live page would then hide and
//     re-reveal.
//   - all ambient/continuously-animated world elements (.field-cyan,
//     .field-violet, #prologue .spark, .trace, .voice) frozen at their
//     0%/first-keyframe state — not an arbitrary mid-animation instant.
//
// How determinism is achieved (tooling-only — nothing below is ever
// written into game-localization/script.js, styles.css, or index.html):
//
//   1. A Playwright `context.add_init_script` runs before ANY of the
//      page's own scripts, in this capture browser context only. It:
//        a) patches `Element.prototype.animate` so any WAAPI animation
//           created by the page (i.e. `animateMobileNarr`'s `el.animate()`
//           call) is paused and rewound to `currentTime = 0` at the exact
//           moment it is created — before its first frame can ever paint.
//        b) runs a continuous `requestAnimationFrame` sweep that calls
//           `document.getAnimations()` and pauses + rewinds every
//           animation (CSS `@keyframes`, CSS transitions, and WAAPI
//           alike) to `currentTime = 0` on every frame. This is what
//           freezes desktop's IntersectionObserver-driven `.narr`
//           opacity/transform transition and the CSS-keyframe ambient
//           elements (field-drift, voice-breathe, prologue spark pulse,
//           trace breathe) at their starting frame, regardless of how
//           many milliseconds have elapsed since the page loaded.
//      This does not touch the page's own IntersectionObserver or
//      requestAnimationFrame wiring at all — `revealObserver`,
//      `revealNarr`, `mobileRevealLoop`, and `animateMobileNarr` all run
//      completely unmodified; only the *animation clocks* they drive are
//      held at their own starting position.
//   2. The real `phase1dThresholdHandoff` sessionStorage marker is seeded
//      before navigation, exactly matching a genuine Crossing → Games
//      handoff (see threshold-integration/phase-a1-integration.js's
//      `writeHandoffMarker()`), so the capture exercises the same
//      `beginThresholdHandoffReveal()` code path a real visitor takes.
//
// Isolation: reads the real repo's game-localization/* via a read-only
// static HTTP server bound to 127.0.0.1 (no repo file is served except
// what already exists on disk); writes only the two canonical PNG paths
// named on the command line (default: the real
// threshold-integration/prebaked/*.png locations) plus an adjacent
// manifest.json for traceability. Uses the globally-installed
// `playwright` package — no new tracked dependency, no lockfile.
//
// Usage:
//   node capture-games-prebake.js
//     -> writes threshold-integration/prebaked/mv-games-desktop.png
//        and threshold-integration/prebaked/mv-games-iphone.png
//   node capture-games-prebake.js --out-dir <dir> [--manifest-only]
//     -> writes mv-games-desktop.png / mv-games-iphone.png into <dir>
//        instead (for producing a non-canonical candidate run without
//        touching the shipped textures).

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "threshold-integration", "prebaked");
const PORT = 8973;
const HOST = "127.0.0.1";

// Canonical viewports — must match threshold-integration/material-engine.js's
// GAMES_TEXTURES sampling assumptions exactly.
const TARGETS = [
  { key: "desktop", file: "mv-games-desktop.png", cssWidth: 1366, cssHeight: 800, dpr: 1 },
  { key: "iphone", file: "mv-games-iphone.png", cssWidth: 390, cssHeight: 844, dpr: 3 },
];

// Injected into the capture browser context ONLY, before any page script
// runs. Never written to any shipped file. See file header for rationale.
//
// Two different "deterministic" targets exist on this page, and they need
// opposite treatment:
//   - Ambient world animation (.field-cyan, .field-violet, #prologue
//     .spark, .trace, .voice) and the narrative reveal itself (desktop's
//     .narr CSS transition, mobile's animateMobileNarr() WAAPI animation)
//     must be pinned at their DETERMINISTIC STARTING frame (currentTime 0)
//     — that's the pre-reveal anchor this tool exists to capture.
//   - The right-side chapter nav's active-state indicator
//     (#side-nav a.active's `color`/background transition, driven by
//     script.js's updateNav(), unrelated to the reveal/ambient systems
//     above) is a plain settle-on-load UI transition. The live page's own
//     first real frame already shows it fully settled (updateNav() runs
//     synchronously on load) — freezing it at currentTime 0 like the
//     other animations was a bug in an earlier version of this tool: it
//     captured the active nav link in its pre-transition grey state
//     instead of the settled amber the real page actually shows
//     immediately, producing a small but real mismatch at the Arrival ->
//     Games boundary. Anything under #side-nav is instead advanced to
//     its END state via `.finish()`, deterministically, regardless of
//     real elapsed time — not by waiting a fixed duration.
const FREEZE_INIT_SCRIPT = `
(() => {
  const isNavSettleTarget = (el) => !!(el && el.closest && el.closest('#side-nav'));
  const freezeAll = () => {
    try {
      document.getAnimations().forEach((a) => {
        try {
          const target = a.effect && a.effect.target;
          if (isNavSettleTarget(target)) {
            a.finish();
          } else {
            a.pause();
            a.currentTime = 0;
          }
        } catch (e) {}
      });
    } catch (e) {}
  };
  const origAnimate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const a = origAnimate.apply(this, args);
    try {
      if (isNavSettleTarget(this)) {
        a.finish();
      } else {
        a.pause();
        a.currentTime = 0;
      }
    } catch (e) {}
    return a;
  };
  let ticks = 0;
  const loop = () => {
    freezeAll();
    if (ticks++ < 300) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__captureFreezeAll = freezeAll;
})();
`;

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on("error", () => {
          if (Date.now() - start > timeoutMs) reject(new Error("static server did not become ready in time"));
          else setTimeout(attempt, 100);
        });
    };
    attempt();
  });
}

async function pngDimensions(filePath) {
  // Minimal PNG IHDR reader — avoids a new dependency for a 2-value read.
  const buf = Buffer.alloc(24);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function captureOne(browser, target, outDir) {
  const context = await browser.newContext({
    viewport: { width: target.cssWidth, height: target.cssHeight },
    deviceScaleFactor: target.dpr,
    reducedMotion: "no-preference",
  });

  // Seed the real handoff marker exactly as
  // threshold-integration/phase-a1-integration.js's writeHandoffMarker()
  // does immediately before `location.assign(link.href)` on a genuine
  // Arrival -> Games navigation, so this capture exercises the real
  // `readHandoffMarker()` -> `beginThresholdHandoffReveal()` path.
  await context.addInitScript(`
    try {
      sessionStorage.setItem('phase1dThresholdHandoff', JSON.stringify({
        version: 1,
        source: 'threshold-integration-phase1d',
        stableAt: Date.now()
      }));
    } catch (e) {}
  `);
  // Deterministic animation freeze (capture-tooling only — see file header).
  await context.addInitScript(FREEZE_INIT_SCRIPT);

  const page = await context.newPage();
  const url = `http://${HOST}:${PORT}/game-localization/index.html`;
  const trace = { target: target.key, url, steps: [] };

  const t0 = Date.now();
  await page.goto(url, { waitUntil: "load" });
  trace.steps.push({ step: "goto:load", atMs: Date.now() - t0 });

  // Wait for the page's OWN existing handoff-entry gate — never forced,
  // never patched in.
  await page.waitForFunction(() => document.documentElement.classList.contains("experience-started"), {
    timeout: 15000,
  });
  trace.steps.push({ step: "experience-started observed", atMs: Date.now() - t0 });

  const classes = await page.evaluate(() => document.documentElement.className);
  trace.classes = classes;

  await page.evaluate(() => (document.fonts && document.fonts.ready ? document.fonts.ready : true));
  trace.steps.push({ step: "document.fonts.ready", atMs: Date.now() - t0 });

  // A few native rAF ticks so the freeze sweep (running on the page's own,
  // unmodified requestAnimationFrame) has caught and rewound anything that
  // was created in the same tick as experience-started, then one explicit
  // synchronous freeze pass immediately before the screenshot.
  await page.waitForTimeout(120);
  await page.evaluate(() => window.__captureFreezeAll && window.__captureFreezeAll());

  await page.evaluate(() => window.scrollTo(0, 0));
  const scrollY = await page.evaluate(() => window.scrollY);
  trace.scrollY = scrollY;

  const narrState = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".narr"))
      .slice(0, 6)
      .map((el, i) => ({
        i,
        hasInClass: el.classList.contains("in"),
        opacity: getComputedStyle(el).opacity,
      })),
  );
  trace.narrState = narrState;

  const worldOpacity = await page.evaluate(() => getComputedStyle(document.getElementById("world")).opacity);
  trace.worldOpacity = worldOpacity;

  // Verification-only, not used to alter the capture: confirms the settled
  // (not frozen-grey) active nav state landed correctly. See the
  // FREEZE_INIT_SCRIPT comment above for why #side-nav is exempted from
  // the currentTime-0 freeze.
  trace.activeNav = await page.evaluate(() => {
    const active = document.querySelector("#side-nav a.active");
    return active
      ? { text: active.textContent, color: getComputedStyle(active).color }
      : null;
  });

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, target.file);
  await page.screenshot({ path: outPath }); // viewport-only, matches how the
  // material engine samples a full-viewport static frame — no fullPage.

  await context.close();

  const stats = fs.statSync(outPath);
  const hash = sha256(outPath);
  const dims = await pngDimensions(outPath);

  return {
    key: target.key,
    file: path.relative(REPO_ROOT, outPath),
    cssWidth: target.cssWidth,
    cssHeight: target.cssHeight,
    dpr: target.dpr,
    expectedPixelDimensions: `${target.cssWidth * target.dpr}x${target.cssHeight * target.dpr}`,
    actualPixelDimensions: `${dims.width}x${dims.height}`,
    sizeBytes: stats.size,
    sha256: hash,
    scrollY,
    trace,
  };
}

function parseArgs(argv) {
  // manifestDir defaults OUTSIDE the repo (os.tmpdir()) deliberately: this
  // tool's only repo-tracked outputs are the two canonical PNGs it is
  // invoked to produce — a traceability manifest is useful locally but is
  // not one of the allowed committed files, so it never lands in the repo
  // tree unless the caller explicitly opts in with --manifest-dir.
  const args = { outDir: DEFAULT_OUT_DIR, manifestDir: require("os").tmpdir() };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--out-dir") args.outDir = path.resolve(argv[++i]);
    else if (argv[i] === "--manifest-dir") args.manifestDir = path.resolve(argv[++i]);
  }
  return args;
}

async function main() {
  const { outDir, manifestDir } = parseArgs(process.argv);

  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", HOST, "--directory", REPO_ROOT], {
    stdio: ["ignore", "ignore", "ignore"],
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceRoute: "/game-localization/index.html",
    servedFrom: `http://${HOST}:${PORT}/ (read-only static server over ${REPO_ROOT}, this process's own, torn down at end of run)`,
    captureMethod:
      "isolated Playwright script, tools/games-prebake-validation/capture-games-prebake.js — no game-localization/* runtime file modified",
    anchorDefinition:
      "handoff-seeded navigation; .narr pre-reveal (opacity 0, base transform); #world/#trail/#side-nav/#mobile-chapter in normal non-suppressed state; ambient CSS/WAAPI animations frozen at their 0%/first-keyframe via capture-tooling-only animation-clock pinning (see file header)",
    outDir: path.relative(REPO_ROOT, outDir),
    targets: {},
  };

  try {
    await waitForServer(`http://${HOST}:${PORT}/game-localization/index.html`);
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
    for (const target of TARGETS) {
      const result = await captureOne(browser, target, outDir);
      manifest.targets[target.key] = result;
      console.log(
        `captured ${target.key} -> ${result.file} (${result.actualPixelDimensions}, ${result.sizeBytes}B, sha256 ${result.sha256.slice(0, 16)}...)`,
      );
    }
    await browser.close();
  } finally {
    server.kill();
  }

  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, `capture-manifest-${Date.now()}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log("wrote", manifestPath);
}

main().catch((error) => {
  console.error("capture failed:", error);
  process.exit(1);
});
