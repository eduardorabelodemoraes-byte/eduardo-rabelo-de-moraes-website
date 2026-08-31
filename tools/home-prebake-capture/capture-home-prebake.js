// Production Integration — Phase 1C: Home Pre-bake Capture (isolated tooling)
//
// Purpose: the frozen, immutable Crossing/Arrival engine (material-engine.js)
// requires TWO static textures to blend between — a Home texture and a Games
// texture (see TEXTURES / GAMES_TEXTURES in the frozen engine, and
// prebaked/mv-manifest.json). Phase 1B already built and validated the Games
// half of this (tools/games-prebake-validation/capture-games-prebake.js).
// This is the analogous, symmetrical tool for the Home half — render the
// REAL, current, unmodified index.html (this repo's own tracked file) at the
// two canonical viewports the frozen checkpoint's own historical Home
// capture used (1366x800 desktop, 390x844 mobile — read directly from the
// checkpoint's own prebaked/mv-manifest.json, not assumed), and save a
// candidate Home texture + a fully traceable manifest.
//
// Isolation: this script only READS repo files (via a plain, read-only
// static HTTP server bound to 127.0.0.1). It writes only inside
// tools/home-prebake-capture/candidates/<runLabel>/. It never touches
// index.html, script.js, styles.css, game-localization/*, either frozen
// checkpoint, or the Phase 1B tooling files. It does not install anything —
// it resolves the globally-installed `playwright` package exactly as
// capture-games-prebake.js already does.
//
// Home has no post-load reveal animation to wait out (confirmed by grep:
// styles.css has no @keyframes/animation rules, and no @font-face/external
// font or CDN dependency — same determinism basis Phase 1B established for
// the Games page), so this capture's settle gate is simpler: full `load`,
// document.fonts.ready, and networkidle are sufficient.
//
// Usage: node capture-home-prebake.js <run-label>
// Produces: candidates/<run-label>/mv-home-desktop.candidate.png
//           candidates/<run-label>/mv-home-iphone.candidate.png
//           candidates/<run-label>/manifest.json

const { chromium } = require("playwright");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OUT_ROOT = path.join(__dirname, "candidates");
const PORT = 8974; // isolated from capture-games-prebake.js's own 8973 and the
                    // checkpoint's historical 8944, to avoid any implied
                    // dependency on those ports being free/owned by this task
const HOST = "127.0.0.1";

// Canonical viewports — copied verbatim from the frozen Arrival checkpoint's
// own prebaked/mv-manifest.json (read directly, not assumed from memory):
//   desktop: cssWidth 1366, cssHeight 800, dpr 1
//   mobile:  cssWidth  390, cssHeight 844, dpr 3
const TARGETS = [
  { key: "desktop", file: "mv-home-desktop.candidate.png", cssWidth: 1366, cssHeight: 800, dpr: 1 },
  { key: "mobile", file: "mv-home-iphone.candidate.png", cssWidth: 390, cssHeight: 844, dpr: 3 }
];

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get(url, (res) => { res.resume(); resolve(); })
        .on("error", () => {
          if (Date.now() - start > timeoutMs) reject(new Error("static server did not become ready in time"));
          else setTimeout(attempt, 100);
        });
    };
    attempt();
  });
}

async function captureOne(page, target) {
  const url = `http://${HOST}:${PORT}/index.html`;
  const trace = { target: target.key, url, steps: [] };

  const t0 = Date.now();
  await page.goto(url, { waitUntil: "load" });
  trace.steps.push({ step: "goto:load", atMs: Date.now() - t0 });

  await page.evaluate(() => document.fonts && document.fonts.ready ? document.fonts.ready : true);
  trace.steps.push({ step: "document.fonts.ready", atMs: Date.now() - t0 });

  try {
    await page.waitForLoadState("networkidle", { timeout: 5000 });
    trace.networkIdleReached = true;
  } catch {
    trace.networkIdleReached = false; // recorded, not silently ignored
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  const scrollY = await page.evaluate(() => window.scrollY);
  trace.scrollY = scrollY;

  // No pointer/hover/focus state has been touched by this script at any
  // point — no click(), no hover(), no focus() call appears anywhere above.
  // In particular the real Home entry link ([data-game-localization-entry])
  // is never interacted with by this capture.

  const outDir = path.join(OUT_ROOT, process.argv[2]);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, target.file);
  await page.screenshot({ path: outPath }); // viewport-only, not fullPage — matches
                                             // capture-games-prebake.js and the
                                             // checkpoint's own historical capture

  const stats = fs.statSync(outPath);
  const hash = sha256(outPath);

  return {
    key: target.key,
    file: `candidates/${process.argv[2]}/${target.file}`,
    cssWidth: target.cssWidth,
    cssHeight: target.cssHeight,
    dpr: target.dpr,
    expectedPixelDimensions: `${target.cssWidth * target.dpr}x${target.cssHeight * target.dpr}`,
    sizeBytes: stats.size,
    sha256: hash,
    scrollY,
    networkIdleReached: trace.networkIdleReached,
    trace
  };
}

async function main() {
  const runLabel = process.argv[2];
  if (!runLabel) {
    console.error("Usage: node capture-home-prebake.js <run-label>");
    process.exit(1);
  }

  const repoHead = execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();
  const repoStatus = execSync("git status --short", { cwd: REPO_ROOT }).toString();

  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", HOST, "--directory", REPO_ROOT], {
    stdio: ["ignore", "ignore", "ignore"]
  });

  const manifest = {
    runLabel,
    generatedAt: new Date().toISOString(),
    repoHead,
    repoWorkingTreeCleanAtCaptureTime: repoStatus.trim().length === 0,
    sourceRoute: "/index.html",
    servedFrom: `http://${HOST}:${PORT}/ (read-only static server over ${REPO_ROOT}, this task's own process, torn down at end of run)`,
    captureMethod: "isolated Playwright script, tools/home-prebake-capture/capture-home-prebake.js — no repo runtime file modified",
    targets: {}
  };

  try {
    await waitForServer(`http://${HOST}:${PORT}/index.html`);

    const browser = await chromium.launch();
    for (const target of TARGETS) {
      const context = await browser.newContext({
        viewport: { width: target.cssWidth, height: target.cssHeight },
        deviceScaleFactor: target.dpr,
        reducedMotion: "no-preference"
      });
      const page = await context.newPage();
      const result = await captureOne(page, target);
      manifest.targets[target.key] = result;
      await context.close();
      console.log(`captured ${target.key} -> ${result.file} (sha256 ${result.sha256.slice(0, 16)}...)`);
    }
    await browser.close();
  } finally {
    server.kill();
  }

  const outDir = path.join(OUT_ROOT, runLabel);
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("wrote", path.join(outDir, "manifest.json"));
}

main().catch((error) => {
  console.error("capture failed:", error);
  process.exit(1);
});
