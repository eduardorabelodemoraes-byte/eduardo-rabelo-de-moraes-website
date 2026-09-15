// phase-a1-integration.js — experiment/liquid-threshold-passage
//
// Adapter for the passage-engine.js architecture (see that file's own
// header for the full rationale). This candidate carries forward exactly
// two pieces of prior, validated infrastructure, unchanged in spirit:
//
//   - The EXIT refinement (prefetchGamesDocument()): a same-origin
//     <link rel="prefetch"> hint for /game-localization/, issued as soon
//     as the passage engine leaves its resting phase.
//   - The handoff marker (writeHandoffMarker()): sessionStorage marker
//     read by game-localization/script.js's own, already-existing
//     readHandoffMarker()/beginThresholdHandoffReveal(), so the Games
//     document enters already knowing it arrived via the passage instead
//     of a cold, ordinary visit.
//
// Everything else is new, because the engine underneath it is new. There
// is no image loading of any kind on this candidate's ENTRY or EXIT path
// (passage-engine.js has no textures), so "ready" no longer depends on
// network requests completing — only on the script itself parsing and
// its (effectively instantaneous) WebGL shader compile. Prewarm is still
// fired as early as possible (unconditionally, at load, not gated on any
// section's scroll visibility) simply because there is no reason not to:
// the cost of doing so is negligible, and it guarantees the click path
// itself never waits on anything.
//
// Navigation trigger: the old "arrivalPhase === 'stable'" (continuous-
// river) / "arrivalPhase === 'stable'" (A4) signals are both gone — this
// engine has no separate Arrival state machine. Real navigation fires
// once passage-engine.js's own materialPhase has read "settled" for a
// full ATMOSPHERE_SETTLE_DURATION (read live from getTimeline(), never
// duplicated as a constant here), matching the same "hold once fully
// converged, then leave" principle validated in continuous-river.

(() => {
  "use strict";

  const ENTRY_SELECTOR = 'a.expertise__link[href="game-localization/"]';
  const BASE = "threshold-integration/";
  const READY_TIMEOUT_MS = 8000;
  const READY_POLL_MS = 30;

  const HANDOFF_STORAGE_KEY = "phase1dThresholdHandoff";
  const HANDOFF_MARKER_VERSION = 1;
  const HANDOFF_MARKER_SOURCE = "threshold-integration-phase1d";

  let bootstrapping = false;
  let handedOff = false;
  let engineReadyPromise = null;

  function log(label, detail) {
    // eslint-disable-next-line no-console
    console.info(`[a1] ${label}`, detail === undefined ? "" : detail);
  }

  window.__a1Instrumentation = {
    clickedAt: null,
    prewarmStartedAt: null,
    prewarmReadyAt: null,
    activatedAt: null,
    events: [],
    fallback: null,
    atmosphereSettledAt: null,
    handoffMarkerWritten: null,
    navigateInitiatedAt: null,
    reentryEvents: [],
    prefetchStartedAt: null,
    prefetchCompletedAt: null,
    prefetchOutcome: null
  };

  function isStandardActivation(event, link) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      link.target === "_blank" ||
      link.hasAttribute("download")
    ) {
      return false;
    }
    try {
      const destination = new URL(link.href, window.location.href);
      return destination.origin === window.location.origin;
    } catch {
      return false;
    }
  }

  function fallbackNavigate(link, reason) {
    window.__a1Instrumentation.fallback = reason;
    log("falling back to ordinary navigation", reason);
    window.location.assign(link.href);
  }

  function ensureStylesheet() {
    if (document.getElementById("a1-passage-harness-css")) return;
    const link = document.createElement("link");
    link.id = "a1-passage-harness-css";
    link.rel = "stylesheet";
    link.href = `${BASE}passage-harness.css`;
    document.head.appendChild(link);
  }

  function loadEngineScript() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = "a1-passage-engine";
      script.src = `${BASE}passage-engine.js`;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("passage-engine.js failed to load"));
      document.body.appendChild(script);
    });
  }

  function waitForEngineReady() {
    return new Promise((resolve, reject) => {
      const start = performance.now();
      (function poll() {
        const passage = window.__mvPassage;
        if (passage && passage.getPhase() !== undefined) {
          const ok = passage.prepare();
          if (ok) { resolve(); return; }
          if (passage.getFallbackReason()) {
            reject(new Error("engine reported fallback: " + passage.getFallbackReason()));
            return;
          }
        }
        if (performance.now() - start > READY_TIMEOUT_MS) {
          reject(new Error(`engine did not become ready within ${READY_TIMEOUT_MS}ms`));
          return;
        }
        window.setTimeout(poll, READY_POLL_MS);
      })();
    });
  }

  // EXIT refinement — same technique/idempotency as every prior
  // candidate: a passive same-origin resource hint, never gating or
  // blocking the real navigation that follows it.
  function prefetchGamesDocument(link, activatedAt) {
    if (document.getElementById("a1-games-prefetch")) return;
    const startedAt = Math.round(performance.now() - activatedAt);
    window.__a1Instrumentation.prefetchStartedAt = startedAt;
    log("issuing games-page prefetch hint", { href: link.href, startedAt });

    const hint = document.createElement("link");
    hint.id = "a1-games-prefetch";
    hint.rel = "prefetch";
    hint.href = link.href;
    hint.onload = () => {
      window.__a1Instrumentation.prefetchCompletedAt = Math.round(performance.now() - activatedAt);
      window.__a1Instrumentation.prefetchOutcome = "loaded";
    };
    hint.onerror = () => {
      window.__a1Instrumentation.prefetchOutcome = "error";
    };
    document.head.appendChild(hint);
  }

  function writeHandoffMarker() {
    const marker = { version: HANDOFF_MARKER_VERSION, source: HANDOFF_MARKER_SOURCE, stableAt: Date.now() };
    try {
      window.sessionStorage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(marker));
      return true;
    } catch {
      return false;
    }
  }

  function ensureEngineReady() {
    if (engineReadyPromise) return engineReadyPromise;
    window.__a1Instrumentation.prewarmStartedAt = Math.round(performance.now());
    engineReadyPromise = (async () => {
      ensureStylesheet();
      if (!window.__mvPassage) {
        await loadEngineScript();
      }
      await waitForEngineReady();
      window.__a1Instrumentation.prewarmReadyAt = Math.round(performance.now());
    })();
    return engineReadyPromise;
  }

  // Unconditional, load-time prewarm. There is no image download to wait
  // on in this architecture, so this resolves in low-single-digit
  // milliseconds in practice — the point is not to save meaningful time,
  // it is to guarantee the click path itself is never the first place
  // the engine's readiness is even checked.
  function armEagerPrewarm() {
    ensureEngineReady().catch((error) => {
      log("prewarm failed (non-fatal, click path will retry)", error && error.message ? error.message : String(error));
    });
  }

  function beginInstrumentation(activatedAt, link) {
    window.__a1Instrumentation.activatedAt = activatedAt;
    let lastPhase = null;
    let prefetchIssued = false;
    let settledAt = null;
    let navigationTriggered = false;

    function record(label) {
      const passage = window.__mvPassage;
      const entry = {
        label,
        tMs: Math.round(performance.now() - activatedAt),
        phase: passage ? passage.getPhase() : null
      };
      window.__a1Instrumentation.events.push(entry);
      log(label, entry);
    }
    record("activate:dispatched");

    function tick() {
      const passage = window.__mvPassage;
      if (!passage) { window.requestAnimationFrame(tick); return; }
      const phase = passage.getPhase();
      if (phase !== lastPhase) {
        record(`materialPhase -> ${phase}`);
        if (phase === "settled") settledAt = performance.now();
        lastPhase = phase;
      }

      if (!prefetchIssued && phase && phase !== "idle") {
        prefetchIssued = true;
        prefetchGamesDocument(link, activatedAt);
      }

      if (!navigationTriggered && phase === "settled" && settledAt !== null) {
        const settleDuration = passage.getTimeline().atmosphereSettle;
        if (performance.now() - settledAt >= settleDuration) {
          navigationTriggered = true;
          window.__a1Instrumentation.atmosphereSettledAt = Math.round(performance.now() - activatedAt);
          const markerWritten = writeHandoffMarker();
          window.__a1Instrumentation.handoffMarkerWritten = markerWritten;
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              window.__a1Instrumentation.navigateInitiatedAt = Math.round(performance.now() - activatedAt);
              log("navigating to target document", { href: link.href });
              window.location.assign(link.href);
            });
          });
          return;
        }
      }
      window.requestAnimationFrame(tick);
    }
    window.requestAnimationFrame(tick);
  }

  async function bootstrap(link) {
    if (bootstrapping || handedOff) return;
    bootstrapping = true;
    try {
      await ensureEngineReady();
      handedOff = true;
      const activatedAt = performance.now();
      window.__mvPassage.activate();
      beginInstrumentation(activatedAt, link);
    } catch (error) {
      fallbackNavigate(link, error && error.message ? error.message : String(error));
    } finally {
      bootstrapping = false;
    }
  }

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest(ENTRY_SELECTOR);
    if (!(link instanceof HTMLAnchorElement)) return;
    if (!isStandardActivation(event, link)) return;

    window.__a1Instrumentation.clickedAt = performance.now();
    event.preventDefault();
    event.stopImmediatePropagation();
    log("gated entry activation intercepted", { href: link.href });
    bootstrap(link);
  }, true);

  armEagerPrewarm();

  // Reentry / Back — a visitor restored from bfcache after completing a
  // passage and pressing Back would otherwise find handedOff still true
  // and bootstrap() permanently no-op. Unchanged in principle from every
  // prior candidate; reset() is passage-engine.js's own public method
  // here, so no button-click indirection is needed.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;

    const wasHandedOff = handedOff;
    const wasBootstrapping = bootstrapping;
    bootstrapping = false;
    handedOff = false;

    const passage = window.__mvPassage;
    let resetInvoked = false;
    if (passage && typeof passage.getPhase === "function" && passage.getPhase() !== "idle") {
      passage.reset();
      resetInvoked = true;
    }

    window.__a1Instrumentation.reentryEvents.push({
      at: Date.now(),
      wasHandedOff,
      wasBootstrapping,
      engineWasPresent: Boolean(passage),
      resetInvoked
    });
    log("pageshow bfcache restore — reentry latches cleared", { wasHandedOff, resetInvoked });
  });
})();
