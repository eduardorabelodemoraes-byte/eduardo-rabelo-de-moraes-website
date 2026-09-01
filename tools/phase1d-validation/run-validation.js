// Production Integration — Phase 1D: local validation harness (isolated tooling).
//
// Read-only against repo source (serves it via a plain static server, never
// modifies it). Writes only inside tools/phase1d-validation/. Drives the
// REAL index.html (gated) through a REAL same-origin navigation into the
// REAL game-localization/index.html, at the two canonical viewports, and
// captures evidence around the navigation boundary: discrete screenshots,
// a continuous video spanning the boundary (for frame-by-frame review),
// and source-side instrumentation/console timing. Also runs the required
// regression checks: ungated Home->Games, direct Games entry, Games
// refresh, and the Games->Home Return link.
//
// This harness never modifies game-localization/script.js,
// threshold-integration/phase1c-integration.js, or any other repo file —
// it only observes them through a real browser.
//
// Usage: node run-validation.js

const { chromium } = require("playwright");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = __dirname;
const SHOTS_DIR = path.join(OUT_DIR, "shots");
const VIDEO_DIR = path.join(OUT_DIR, "video");
const FRAMES_DIR = path.join(OUT_DIR, "frames");
const PORT = 8976;
const HOST = "127.0.0.1";

const VIEWPORTS = {
  desktop: { width: 1366, height: 800, dpr: 1 },
  mobile: { width: 390, height: 844, dpr: 3 }
};

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

async function readInstrumentation(page) {
  return page.evaluate(() => {
    const inst = window.__phase1cInstrumentation;
    if (!inst) return null;
    return JSON.parse(JSON.stringify(inst));
  }).catch(() => null);
}

async function extractFramesFromVideo(videoPath, destDir, fps) {
  fs.mkdirSync(destDir, { recursive: true });
  const result = spawnSync("ffmpeg", [
    "-y", "-i", videoPath,
    "-vf", `fps=${fps}`,
    path.join(destDir, "frame-%04d.png")
  ], { stdio: ["ignore", "pipe", "pipe"] });
  return {
    ok: result.status === 0,
    stderrTail: result.stderr ? result.stderr.toString("utf8").split("\n").slice(-15).join("\n") : null
  };
}

// --- Gated Threshold-completed handoff, at one viewport ------------------

async function runGatedHandoff(browser, key) {
  const vp = VIEWPORTS[key];
  const report = { key, viewport: vp };

  const videoSubDir = path.join(VIDEO_DIR, key);
  fs.mkdirSync(videoSubDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    recordVideo: { dir: videoSubDir, size: { width: vp.width, height: vp.height } }
  });
  const page = await context.newPage();

  const consoleLines = [];
  page.on("console", (msg) => consoleLines.push({ atMs: Date.now(), text: msg.text() }));
  page.on("pageerror", (err) => consoleLines.push({ atMs: Date.now(), text: `PAGEERROR: ${err.message}` }));

  const contextCreatedAt = Date.now();
  report.url = `http://${HOST}:${PORT}/index.html?thresholdIntegration=1`;
  await page.goto(report.url, { waitUntil: "load" });

  // Marker-lifecycle check (1): absent before stable.
  report.markerBeforeActivation = await page.evaluate((k) => window.sessionStorage.getItem(k), "phase1dThresholdHandoff").catch(() => "N/A");

  await page.screenshot({ path: path.join(SHOTS_DIR, `${key}-00-before-activation.png`) });

  let navigated = false;
  let navigatedAtWallClock = null;
  page.once("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      navigated = true;
      navigatedAtWallClock = Date.now();
    }
  });

  await page.click("[data-game-localization-entry]");

  const events = [];
  let sourceStableFrameTaken = false;
  let markerAtStable = null;
  const pollDeadline = Date.now() + 12000;

  while (Date.now() < pollDeadline && !navigated) {
    const state = await readInstrumentation(page);
    if (state === null) {
      // Either the engine hasn't attached yet, or the page has already
      // begun navigating away (execution context torn down). Either way,
      // stop polling — navigation will be picked up below.
      if (navigated) break;
      await page.waitForTimeout(30);
      continue;
    }

    if (state.events.length > events.length) {
      for (let i = events.length; i < state.events.length; i++) events.push(state.events[i]);
    }

    if (!sourceStableFrameTaken && state.arrivalStableAt !== null) {
      sourceStableFrameTaken = true;
      report.arrivalStableAtMs = state.arrivalStableAt;
      // Best-effort proxy for "final source Stable Games canvas frame":
      // taken at the earliest poll tick that observes arrivalStableAt set.
      // The engine's own render loop has no further state change to make
      // at this point (Arrival is complete), and navigation is still at
      // minimum two rAF callbacks away (see phase1c-integration.js), so
      // this frame and the literal last-painted source frame should be
      // visually indistinguishable; the video capture below is the
      // authoritative record for verifying that claim frame-by-frame.
      await page.screenshot({ path: path.join(SHOTS_DIR, `${key}-01-source-stable-detected.png`) }).catch(() => {});
      markerAtStable = await page.evaluate((k) => window.sessionStorage.getItem(k), "phase1dThresholdHandoff").catch(() => null);
    }

    report.handoffMarkerWritten = state.handoffMarkerWritten;
    report.navigateInitiatedAtMs = state.navigateInitiatedAt;

    await page.waitForTimeout(20);
  }

  report.events = events;
  report.markerReadAtStableTick = markerAtStable; // marker-lifecycle check (2)
  report.navigatedDetectedViaFrameNavigated = navigated;
  report.navigatedAtWallClockDeltaMs = navigatedAtWallClock ? navigatedAtWallClock - contextCreatedAt : null;

  // First visible target frame: as soon as Playwright observes the
  // top-level frame navigation, before waiting for full load.
  if (!navigated) {
    // Fall back to an explicit wait if the polling loop exited on timeout
    // rather than because framenavigated already fired.
    await page.waitForURL(/game-localization/, { timeout: 8000 }).catch(() => {});
  }
  await page.screenshot({ path: path.join(SHOTS_DIR, `${key}-02-first-target-frame.png`) }).catch(() => {});

  await page.waitForLoadState("load").catch(() => {});
  await page.screenshot({ path: path.join(SHOTS_DIR, `${key}-03-target-loaded.png`) }).catch(() => {});

  // Settle window: with no animation on this path there should be nothing
  // left to change, but this frame is captured to demonstrate that.
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS_DIR, `${key}-04-target-settled.png`) }).catch(() => {});

  report.targetUrl = page.url();
  report.targetState = await page.evaluate(() => ({
    classList: Array.from(document.documentElement.classList),
    scrollY: window.scrollY,
    markerStillPresent: window.sessionStorage.getItem("phase1dThresholdHandoff"), // marker-lifecycle check (3)
    legacyMarkerPresent: window.sessionStorage.getItem("gameLocalizationEntry"),
    prologueOpeningOpacity: (() => {
      const el = document.querySelector("[data-prologue-opening]");
      return el ? getComputedStyle(el).opacity : null;
    })(),
    prologueResponseOpacity: (() => {
      const el = document.querySelector("[data-prologue-response]");
      return el ? getComputedStyle(el).opacity : null;
    })(),
    title: document.title
  })).catch(() => null);

  // Marker-lifecycle check (5): refresh on Games must NOT re-trigger the
  // instant reveal (marker was already one-shot consumed above).
  await page.reload({ waitUntil: "domcontentloaded" });
  const immediatelyAfterReload = await page.evaluate(() => document.documentElement.classList.contains("experience-started")).catch(() => null);
  await page.waitForTimeout(950);
  const afterHoldWaitOnReload = await page.evaluate(() => document.documentElement.classList.contains("experience-started")).catch(() => null);
  report.refreshRegression = { immediatelyAfterReload, afterHoldWaitOnReload };

  report.consoleLines = consoleLines.filter((l) => l.text.startsWith("[phase1c]") || l.text.startsWith("PAGEERROR"));

  await context.close();
  const videoPath = await page.video()?.path().catch(() => null);
  report.videoPath = videoPath ? path.relative(OUT_DIR, videoPath) : null;

  if (videoPath && fs.existsSync(videoPath)) {
    const extraction = await extractFramesFromVideo(videoPath, path.join(FRAMES_DIR, key), 20);
    report.frameExtraction = { ...extraction, fps: 20, dir: path.relative(OUT_DIR, path.join(FRAMES_DIR, key)) };
  } else {
    report.frameExtraction = { ok: false, reason: "video file not found after context close" };
  }

  return report;
}

// --- Direct / refresh / Return-link regression (no Home involved) --------

async function runDirectGamesRegression(browser) {
  const report = {};
  const context = await browser.newContext({ viewport: { width: 1366, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  const directUrl = `http://${HOST}:${PORT}/game-localization/index.html`;
  await page.goto(directUrl, { waitUntil: "domcontentloaded" });

  report.markerPresentOnDirectEntry = await page.evaluate(() => ({
    handoff: window.sessionStorage.getItem("phase1dThresholdHandoff"),
    legacy: window.sessionStorage.getItem("gameLocalizationEntry")
  })).catch(() => null);

  report.immediatelyAfterDirectLoad = await page.evaluate(() => document.documentElement.classList.contains("experience-started")).catch(() => null);
  await page.waitForTimeout(900);
  report.afterHoldWaitDirectLoad = await page.evaluate(() => document.documentElement.classList.contains("experience-started")).catch(() => null);
  await page.screenshot({ path: path.join(SHOTS_DIR, "direct-01-settled.png") }).catch(() => {});

  // Refresh on Games (second direct-style load in the same session).
  await page.reload({ waitUntil: "domcontentloaded" });
  report.immediatelyAfterRefresh = await page.evaluate(() => document.documentElement.classList.contains("experience-started")).catch(() => null);
  await page.waitForTimeout(900);
  report.afterHoldWaitRefresh = await page.evaluate(() => document.documentElement.classList.contains("experience-started")).catch(() => null);

  // Return link -> Home, ordinary navigation.
  const exitHref = await page.getAttribute("[data-experience-exit]", "href").catch(() => null);
  report.exitLinkHref = exitHref;
  await page.click("[data-experience-exit]");
  await page.waitForLoadState("load").catch(() => {});
  report.urlAfterReturnClick = page.url();

  await context.close();
  return report;
}

// --- Ungated Home -> Games (legacy ThresholdController path) -------------

async function runUngatedRegression(browser) {
  const report = {};
  const context = await browser.newContext({ viewport: { width: 1366, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  const url = `http://${HOST}:${PORT}/index.html`;
  await page.goto(url, { waitUntil: "load" });
  report.mvElementsPresentBeforeClick = await page.evaluate(() => !!document.getElementById("mv-canvas"));
  report.phase1dMarkerBeforeClick = await page.evaluate(() => window.sessionStorage.getItem("phase1dThresholdHandoff")).catch(() => null);

  const nav = page.waitForNavigation({ waitUntil: "load", timeout: 10000 }).catch(() => null);
  await page.click("[data-game-localization-entry]");
  const navResult = await nav;
  report.navigated = !!navResult;
  report.finalUrl = page.url();

  report.phase1dMarkerAfterLanding = await page.evaluate(() => window.sessionStorage.getItem("phase1dThresholdHandoff")).catch(() => "N/A (page did not settle)");
  report.legacyMarkerConsumedOrAbsent = await page.evaluate(() => window.sessionStorage.getItem("gameLocalizationEntry")).catch(() => "N/A");
  report.classListAfterLanding = await page.evaluate(() => Array.from(document.documentElement.classList)).catch(() => "N/A");

  await context.close();
  return report;
}

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", HOST, "--directory", REPO_ROOT], {
    stdio: ["ignore", "ignore", "ignore"]
  });

  const report = { generatedAt: new Date().toISOString(), targets: {} };

  try {
    await waitForServer(`http://${HOST}:${PORT}/index.html`);
    const browser = await chromium.launch();

    report.targets.desktop = await runGatedHandoff(browser, "desktop");
    report.targets.mobile = await runGatedHandoff(browser, "mobile");
    report.directGamesRegression = await runDirectGamesRegression(browser);
    report.ungatedRegression = await runUngatedRegression(browser);

    await browser.close();
  } finally {
    server.kill();
  }

  const outPath = path.join(OUT_DIR, "validation-report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log("wrote", outPath);
}

main().catch((error) => {
  console.error("validation failed:", error);
  process.exit(1);
});
