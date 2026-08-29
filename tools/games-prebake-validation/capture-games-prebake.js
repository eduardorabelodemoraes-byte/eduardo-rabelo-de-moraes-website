// Production Integration — Phase 1B: Games Pre-bake Pipeline (isolated tooling)
//
// Purpose: render the REAL, current, unmodified game-localization/index.html
// (this repo's own tracked file) at the two canonical viewports the frozen
// Crossing/Arrival checkpoint already uses, wait deterministically for the
// page's own normal Stable-Games reveal to complete (never modifying the
// page to force this — only observing state it already exposes), and save
// a candidate texture + a fully traceable manifest.
//
// Isolation: this script only READS repo files (via a plain, read-only
// static HTTP server bound to 127.0.0.1, serving this repo — the exact
// pattern the checkpoint's own capture-games-texture.js documents itself
// using: "via a plain static file server pointed at the repo root, started
// separately... screenshots it. No repo file is modified."). It writes
// only inside tools/games-prebake-validation/candidates/<runLabel>/. It
// never touches index.html, script.js, styles.css, game-localization/*, or
// either frozen checkpoint. It does not install anything — it resolves
// the globally-installed `playwright` package exactly as every prior
// Playwright script in this project's history has (no local package.json,
// no lockfile, no new tracked dependency).
//
// Usage: node capture-games-prebake.js <run-label>
// Produces: candidates/<run-label>/mv-games-desktop.candidate.png
//           candidates/<run-label>/mv-games-iphone.candidate.png
//           candidates/<run-label>/manifest.json

const { chromium } = require("playwright");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OUT_ROOT = path.join(__dirname, "candidates");
const PORT = 8973; // isolated from the checkpoint's own historical 8960, to avoid any
                    // implied dependency on that port being free/owned by this task
const HOST = "127.0.0.1";

// Canonical viewports — copied verbatim from the frozen checkpoint's own
// prebaked/mv-games-manifest.json (read directly, not assumed from memory):
//   desktop: cssWidth 1366, cssHeight 800, dpr 1
//   mobile:  cssWidth  390, cssHeight 844, dpr 3
const TARGETS = [
  { key: "desktop", file: "mv-games-desktop.candidate.png", cssWidth: 1366, cssHeight: 800, dpr: 1 },
  { key: "mobile", file: "mv-games-iphone.candidate.png", cssWidth: 390, cssHeight: 844, dpr: 3 }
];

// Derived deterministically from game-localization/styles.css, read directly
// (not guessed): the prologue text keyframe animations are
//   `prologue-line-in 900ms ease forwards`            (starts at experience-started)
//   `prologue-line-in 900ms 1.15s ease forwards`       (delayed 1150ms, same duration)
// so the LAST animation frame settles at (experience-started) + 1150 + 900 = 2050ms.
const POST_REVEAL_SETTLE_MS = 2050;

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
  const context = page.context();
  const url = `http://${HOST}:${PORT}/game-localization/index.html`;

  const trace = { target: target.key, url, steps: [] };

  const t0 = Date.now();
  await page.goto(url, { waitUntil: "load" });
  trace.steps.push({ step: "goto:load", atMs: Date.now() - t0 });

  // Deterministic Stable-Games gate: wait for the PAGE'S OWN existing reveal
  // class, exactly as it already governs real visitors — never forced,
  // never patched in. This is read-only observation of existing behavior.
  await page.waitForFunction(
    () => document.documentElement.classList.contains("experience-started"),
    { timeout: 15000 }
  );
  const revealedAtMs = Date.now() - t0;
  trace.steps.push({ step: "experience-started observed", atMs: revealedAtMs });

  const failsafeEngaged = await page.evaluate(
    () => document.documentElement.classList.contains("experience-failsafe")
  );
  trace.failsafeEngaged = failsafeEngaged; // recorded for traceability; false is the
                                            // expected/normal path for a direct load

  // Fonts readiness — real signal from the browser's own font-loading API,
  // not a guess.
  await page.evaluate(() => document.fonts && document.fonts.ready ? document.fonts.ready : true);
  trace.steps.push({ step: "document.fonts.ready", atMs: Date.now() - t0 });

  // Let the page's own prologue keyframe animations finish settling (derived
  // from styles.css, see POST_REVEAL_SETTLE_MS comment above) — this is
  // waiting for existing, unmodified CSS to reach its own natural end state,
  // not injecting new timing.
  await page.waitForTimeout(POST_REVEAL_SETTLE_MS);
  trace.steps.push({ step: "post-reveal settle wait complete", atMs: Date.now() - t0, waitedMs: POST_REVEAL_SETTLE_MS });

  // Asset/network settle.
  try {
    await page.waitForLoadState("networkidle", { timeout: 5000 });
    trace.networkIdleReached = true;
  } catch {
    trace.networkIdleReached = false; // recorded, not silently ignored
  }

  // Scroll position must be the page's own normal initial position.
  await page.evaluate(() => window.scrollTo(0, 0));
  const scrollY = await page.evaluate(() => window.scrollY);
  trace.scrollY = scrollY;

  // No pointer/hover/focus state has been touched by this script at any
  // point — no click(), no hover(), no focus() call appears anywhere above.

  const outDir = path.join(OUT_ROOT, process.argv[2]);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, target.file);
  await page.screenshot({ path: outPath }); // viewport-only, not fullPage — matches the
                                             // checkpoint's own capture-games-texture.js

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
    failsafeEngaged,
    networkIdleReached: trace.networkIdleReached,
    revealedAtMs,
    trace
  };
}

async function main() {
  const runLabel = process.argv[2];
  if (!runLabel) {
    console.error("Usage: node capture-games-prebake.js <run-label>");
    process.exit(1);
  }

  const repoHead = execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();
  const repoStatus = execSync("git status --short", { cwd: REPO_ROOT }).toString();

  // Read-only static file server over the real repo — no repo file is
  // written by this process at any point.
  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", HOST, "--directory", REPO_ROOT], {
    stdio: ["ignore", "ignore", "ignore"]
  });

  const manifest = {
    runLabel,
    generatedAt: new Date().toISOString(),
    repoHead,
    repoWorkingTreeCleanAtCaptureTime: repoStatus.trim().length === 0,
    sourceRoute: "/game-localization/index.html",
    servedFrom: `http://${HOST}:${PORT}/ (read-only static server over ${REPO_ROOT}, this task's own process, torn down at end of run)`,
    captureMethod: "isolated Playwright script, tools/games-prebake-validation/capture-games-prebake.js — no repo runtime file modified",
    targets: {}
  };

  try {
    await waitForServer(`http://${HOST}:${PORT}/game-localization/index.html`);

    const browser = await chromium.launch();
    for (const target of TARGETS) {
      const context = await browser.newContext({
        viewport: { width: target.cssWidth, height: target.cssHeight },
        deviceScaleFactor: target.dpr,
        reducedMotion: "no-preference" // explicit, matches the default a visitor without an
                                        // OS-level reduced-motion preference would get, and
                                        // matches what the checkpoint's own capture assumed
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
