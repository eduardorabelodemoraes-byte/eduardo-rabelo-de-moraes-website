// Production Integration — Phase 1C: local validation harness (isolated tooling).
//
// Read-only against repo source (serves it via a plain static server, never
// modifies it). Writes only inside tools/phase1c-validation/. Drives the
// REAL index.html (with and without the ?thresholdIntegration=1 gate) via
// Playwright against a real Chromium, at the two canonical viewports.
//
// Usage: node run-validation.js

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SHOTS_DIR = path.join(__dirname, "shots");
const PORT = 8975;
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

async function runUngatedControl(browser, label) {
  const report = { label, url: `http://${HOST}:${PORT}/index.html` };
  const context = await browser.newContext({ viewport: { width: 1366, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  await page.goto(report.url, { waitUntil: "load" });
  report.mvElementsPresentBeforeClick = await page.evaluate(() => !!document.getElementById("mv-canvas"));

  const nav = page.waitForNavigation({ waitUntil: "load", timeout: 8000 }).catch(() => null);
  await page.click("[data-game-localization-entry]");
  const navResult = await nav;
  report.navigated = !!navResult;
  report.finalUrl = page.url();
  report.mvElementsPresentAfterClick = await page.evaluate(() => !!document.getElementById("mv-canvas")).catch(() => "page navigated away, N/A");
  report.phase1cInstrumentationExists = await page.evaluate(() => typeof window.__phase1cInstrumentation !== "undefined").catch(() => "page navigated away, N/A");

  await context.close();
  return report;
}

async function runGated(browser, key) {
  const vp = VIEWPORTS[key];
  const report = { key, viewport: vp, url: `http://${HOST}:${PORT}/index.html?thresholdIntegration=1` };
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr
  });
  const page = await context.newPage();
  const consoleLines = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  page.on("pageerror", (err) => consoleLines.push(`PAGEERROR: ${err.message}`));

  await page.goto(report.url, { waitUntil: "load" });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${key}-00-before-activation.png`) });

  const startUrl = page.url();
  await page.click("[data-game-localization-entry]");

  // Screenshot shortly after click (mid-Formation expected).
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS_DIR, `${key}-01-shortly-after-click.png`) });

  // Poll instrumentation for phase/arrival transitions and key screenshots.
  const events = [];
  let sawRevealed = false;
  let sawArrivalActive = false;
  let arrivalStableAt = null;
  const deadline = Date.now() + 12000;

  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const inst = window.__phase1cInstrumentation;
      if (!inst) return null;
      return {
        events: inst.events,
        arrivalStableAt: inst.arrivalStableAt,
        fallback: inst.fallback,
        activatedAt: inst.activatedAt
      };
    }).catch(() => null);

    if (state) {
      if (state.fallback) {
        report.fallbackReason = state.fallback;
        break;
      }
      if (state.events.length > events.length) {
        for (let i = events.length; i < state.events.length; i++) {
          events.push(state.events[i]);
        }
      }
      if (!sawRevealed && state.events.some((e) => e.phase === "revealed")) {
        sawRevealed = true;
        await page.screenshot({ path: path.join(SHOTS_DIR, `${key}-02-t3-revealed.png`) });
      }
      if (!sawArrivalActive && state.events.some((e) => e.arrivalPhase === "active")) {
        sawArrivalActive = true;
        await page.screenshot({ path: path.join(SHOTS_DIR, `${key}-03-arrival-active.png`) });
      }
      if (state.arrivalStableAt !== null && arrivalStableAt === null) {
        arrivalStableAt = state.arrivalStableAt;
        await page.screenshot({ path: path.join(SHOTS_DIR, `${key}-04-arrival-stable.png`) });
        break;
      }
    }
    await page.waitForTimeout(80);
  }

  report.events = events;
  report.arrivalStableAtMs = arrivalStableAt;
  report.urlDuringSequence = page.url();
  report.urlUnchanged = page.url() === startUrl;

  // Hold check: wait an additional 1500ms after stable, confirm no navigation.
  if (arrivalStableAt !== null) {
    await page.waitForTimeout(1500);
    report.urlAfterHoldWait = page.url();
    report.stillHeld = page.url() === startUrl;
    await page.screenshot({ path: path.join(SHOTS_DIR, `${key}-05-post-stable-hold.png`) });
  }

  report.consoleLines = consoleLines.filter((l) => l.startsWith("[phase1c]") || l.startsWith("PAGEERROR"));

  await context.close();
  return report;
}

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", HOST, "--directory", REPO_ROOT], {
    stdio: ["ignore", "ignore", "ignore"]
  });

  const report = { targets: {} };

  try {
    await waitForServer(`http://${HOST}:${PORT}/index.html`);
    const browser = await chromium.launch();

    report.ungatedControlBefore = await runUngatedControl(browser, "ungated-control-before");
    report.targets.desktop = await runGated(browser, "desktop");
    report.targets.mobile = await runGated(browser, "mobile");
    report.ungatedRegressionAfter = await runUngatedControl(browser, "ungated-regression-after");

    await browser.close();
  } finally {
    server.kill();
  }

  const outPath = path.join(__dirname, "validation-report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log("\nwrote", outPath);
}

main().catch((error) => {
  console.error("validation failed:", error);
  process.exit(1);
});
