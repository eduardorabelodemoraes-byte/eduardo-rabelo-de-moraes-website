// Production Integration — Phase 1C/1D: Home-side production adapter.
//
// This file is PRODUCTION-INTEGRATION ADAPTER LOGIC, not canonical engine
// logic. It never touches C400/Crossing/Arrival calculations. Its only job
// is: (1) stay a complete no-op unless an explicit, narrow test gate is
// present in the URL; (2) under that gate, intercept the real, existing
// [data-game-localization-entry] link before the old ThresholdController
// (script.js) can act on it; (3) load the frozen, byte-identical
// material-engine.js + material-harness.css + prebaked textures alongside
// this file, and drive its own already-existing activate() entry point
// exactly as a real user clicking "Activate" in the standalone checkpoint
// harness would; (4) once arrivalPhase becomes "stable" (Phase 1C's frozen
// end state), write a narrow one-shot handoff marker and perform an
// ordinary same-origin navigation to the real /game-localization/ document
// — Phase 1D's only addition, and only after the state Phase 1C already
// established, never before it; (5) fail safe to ordinary navigation if
// setup does not complete before the engine has taken control.
//
// Canonical engine transport: material-engine.js and material-harness.css
// living alongside this file are byte-identical, unmodified copies of the
// frozen Arrival checkpoint's own crossing-source/material-engine.js and
// crossing-source/material-harness.css (verified via sha256 at copy time —
// see the Phase 1C final report). This adapter never edits, wraps, or
// monkey-patches those files' contents; it only decides WHEN to insert them
// into the real document and WHAT already-existing entry point
// (#mv-activate) to invoke on the real page's behalf.
//
// Phase 1D handoff: everything up through arrivalPhase === "stable" is
// unmodified Phase 1C behavior (see beginInstrumentation()/tick() below —
// the phase/subStage/arrivalPhase polling loop is byte-for-byte what Phase
// 1C shipped). The only new logic is what now happens AT the stable
// transition: previously this adapter stopped and held forever; it now
// additionally writes HANDOFF_STORAGE_KEY (see writeHandoffMarker()) and
// navigates via window.location.assign(link.href) — the same ordinary,
// same-origin URL the real anchor already pointed to. No fetch-and-inject,
// no iframe, no SPA routing, no History API trickery.

(() => {
  "use strict";

  const GATE_PARAM = "thresholdIntegration";
  const ENTRY_SELECTOR = "[data-game-localization-entry]";
  const BASE = "threshold-integration/";
  const READY_TIMEOUT_MS = 8000;
  const READY_POLL_MS = 40;

  // Phase 1D handoff marker. Deliberately a NEW, separate sessionStorage key
  // from script.js's own "gameLocalizationEntry" marker rather than an
  // extension of it: the legacy marker's schema (mode + blackAt) exists to
  // drive a *matching black-hold duration* on the target page, which is
  // exactly the behavior this handoff must NOT trigger (there is no black
  // hold to match — the visitor is already looking at the stable Games
  // frame). Reusing that schema would either require overloading `mode`
  // with a meaning it was never designed for, or leave a stale `blackAt`
  // that game-localization/script.js would try to subtract a hold against.
  // A distinct key with its own version/source identity keeps both paths
  // fully independent and unambiguous to read.
  const HANDOFF_STORAGE_KEY = "phase1dThresholdHandoff";
  const HANDOFF_MARKER_VERSION = 1;
  const HANDOFF_MARKER_SOURCE = "threshold-integration-phase1d";

  let gateActive = false;
  try {
    gateActive = new URLSearchParams(window.location.search).get(GATE_PARAM) === "1";
  } catch {
    gateActive = false;
  }

  // Ungated: this script does nothing else at all — no listeners, no DOM
  // injection, no network requests beyond having been fetched itself. This
  // is the whole of the "ungated behavior must remain unchanged" contract.
  if (!gateActive) {
    return;
  }

  let bootstrapping = false;
  let handedOff = false;

  function log(label, detail) {
    // Console-only instrumentation, per instruction section "Provide
    // internal instrumentation... Console or internal state reporting is
    // acceptable. A permanent visible debug HUD is not." Nothing here
    // renders to the page.
    // eslint-disable-next-line no-console
    console.info(`[phase1c] ${label}`, detail === undefined ? "" : detail);
  }

  // Structured instrumentation surface for automated validation (Playwright)
  // to read after the fact — an internal state object, not a visible HUD.
  window.__phase1cInstrumentation = {
    gateActive: true,
    clickedAt: null,
    activatedAt: null, // T0 reference point: activate() invoked
    events: [], // { label, tMs (relative to activatedAt), phase, revealSubStage, arrivalPhase, arrivalOpticalMix }
    fallback: null, // set to a reason string if the fallback path was taken
    arrivalStableAt: null,
    handoffMarkerWritten: null, // Phase 1D: true/false once attempted
    navigateInitiatedAt: null // Phase 1D: tMs (relative to activatedAt) when location.assign() was called
  };

  // Phase 1D: narrow, isolated, standards-based hint only. Injected once,
  // in parallel with engine loading — never depended on for correctness.
  // If the browser ignores or fails to honor it, the eventual ordinary
  // navigation to link.href behaves identically either way.
  function ensurePrefetchHint(link) {
    if (document.getElementById("phase1d-target-prefetch")) {
      return;
    }
    try {
      const hint = document.createElement("link");
      hint.id = "phase1d-target-prefetch";
      hint.rel = "prefetch";
      hint.href = link.href;
      document.head.appendChild(hint);
    } catch {
      // Best-effort only — absence of this hint has no functional effect.
    }
  }

  // Phase 1D: one-shot handoff marker, written only at the moment
  // arrivalPhase first becomes "stable" and only immediately before the
  // navigation that follows it (see tick() below). Consumed and deleted by
  // game-localization/script.js on the very next document load; never read
  // back by this document, so there is no dependency on Home surviving
  // past the moment navigation is issued.
  function writeHandoffMarker() {
    const marker = {
      version: HANDOFF_MARKER_VERSION,
      source: HANDOFF_MARKER_SOURCE,
      stableAt: Date.now()
    };
    try {
      window.sessionStorage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(marker));
      return true;
    } catch {
      // If sessionStorage is unavailable, navigation still proceeds below —
      // the target page simply finds no marker and falls back to its own
      // normal/direct entry behavior. This is the same fail-safe contract
      // the legacy marker already relies on.
      return false;
    }
  }

  function isStandardActivation(event, link) {
    // Mirrors script.js's own isStandardActivation() check (same
    // conditions, independently re-implemented here rather than importing
    // from script.js, to keep this adapter fully separable from the old
    // ThresholdController's internals per instruction). Any non-standard
    // activation (modifier key, middle/right click, target=_blank,
    // download, cross-origin) is left completely alone — neither this
    // adapter nor the old system intercepts it, so native browser behavior
    // applies exactly as it would with no Phase 1C code present at all.
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
    window.__phase1cInstrumentation.fallback = reason;
    log("falling back to ordinary navigation", reason);
    window.location.assign(link.href);
  }

  function ensureStylesheet() {
    if (document.getElementById("phase1c-material-harness-css")) {
      return;
    }
    const link = document.createElement("link");
    link.id = "phase1c-material-harness-css";
    link.rel = "stylesheet";
    link.href = `${BASE}material-harness.css`;
    document.head.appendChild(link);
  }

  function ensureMarkup() {
    if (document.getElementById("mv-canvas")) {
      return;
    }

    // Canvas — the frozen engine's own required, unguarded element.
    const canvas = document.createElement("canvas");
    canvas.id = "mv-canvas";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);

    // The frozen engine's other three REQUIRED (unguarded) elements —
    // status span, activate button, reset button — confirmed by direct
    // source inspection of material-engine.js (every other control element
    // it looks up by id is used only behind an `if (x)` guard and is
    // therefore optional; these three are not, and their absence throws).
    // They are wrapped in a `hidden` container: functionally present for
    // the engine to drive/observe, but not rendered, not in the
    // accessibility tree, and not in the tab order — this adapter never
    // exposes a visible developer control or debug button in the normal
    // page (activation is dispatched programmatically below, never via a
    // visible button for a real visitor to find).
    const controls = document.createElement("div");
    controls.id = "mv-controls";
    controls.hidden = true;
    // The `hidden` attribute alone is not sufficient here: the canonical,
    // byte-identical material-harness.css sets `#mv-controls { display:
    // flex; ... }` with ID-selector specificity, which overrides the
    // browser's default `[hidden] { display: none }` UA rule (lower,
    // attribute-selector specificity) — the same class of CSS-specificity
    // trap material-harness.css's own comments describe elsewhere. An
    // inline style (highest precedence short of `!important` on the
    // external rule, which material-harness.css does not use) reliably
    // forces this ADAPTER-owned wrapper invisible regardless of the
    // canonical, unmodified stylesheet's own rules. This does not touch
    // material-harness.css itself and has no effect on the engine, which
    // never reads this element's computed style.
    controls.style.setProperty("display", "none", "important");

    const activateBtn = document.createElement("button");
    activateBtn.id = "mv-activate";
    activateBtn.type = "button";
    activateBtn.disabled = true;
    activateBtn.tabIndex = -1;

    const resetBtn = document.createElement("button");
    resetBtn.id = "mv-reset";
    resetBtn.type = "button";
    resetBtn.disabled = true;
    resetBtn.tabIndex = -1;

    const status = document.createElement("span");
    status.id = "mv-status";
    status.dataset.state = "idle";
    status.textContent = "idle";

    controls.appendChild(activateBtn);
    controls.appendChild(resetBtn);
    controls.appendChild(status);
    document.body.appendChild(controls);
  }

  function loadEngineScript() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = "phase1c-material-engine";
      script.src = `${BASE}material-engine.js`;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("material-engine.js failed to load"));
      document.body.appendChild(script);
    });
  }

  function waitForEngineReady() {
    return new Promise((resolve, reject) => {
      const start = performance.now();
      let settled = false;

      function onRejection(event) {
        if (settled) return;
        settled = true;
        window.removeEventListener("unhandledrejection", onRejection);
        reject(new Error(`engine initialize() rejected: ${event.reason && event.reason.message ? event.reason.message : event.reason}`));
      }
      // Per source inspection of material-engine.js: initialize() is an
      // async function invoked bare (no .then/.catch), so a failure before
      // its internal try-block (e.g. a required DOM element missing)
      // surfaces only as an unhandled promise rejection, not a synchronous
      // throw — this listener is the only reliable way to observe that
      // class of failure.
      window.addEventListener("unhandledrejection", onRejection);

      function poll() {
        if (settled) return;

        const activateBtn = document.getElementById("mv-activate");
        const statusEl = document.getElementById("mv-status");

        if (statusEl && statusEl.dataset.state === "fallback") {
          settled = true;
          window.removeEventListener("unhandledrejection", onRejection);
          reject(new Error(`engine reported fallback status: ${statusEl.textContent}`));
          return;
        }

        if (activateBtn && activateBtn.disabled === false && window.__mvCrossing) {
          settled = true;
          window.removeEventListener("unhandledrejection", onRejection);
          resolve();
          return;
        }

        if (performance.now() - start > READY_TIMEOUT_MS) {
          settled = true;
          window.removeEventListener("unhandledrejection", onRejection);
          reject(new Error(`engine did not become ready within ${READY_TIMEOUT_MS}ms`));
          return;
        }

        window.setTimeout(poll, READY_POLL_MS);
      }
      poll();
    });
  }

  function beginInstrumentation(activatedAt, link) {
    window.__phase1cInstrumentation.activatedAt = activatedAt;

    let lastPhase = null;
    let lastSubStage = null;
    let lastArrivalPhase = null;

    function record(label) {
      const crossing = window.__mvCrossing;
      const entry = {
        label,
        tMs: Math.round(performance.now() - activatedAt),
        phase: crossing ? crossing.getPhase() : null,
        revealSubStage: crossing ? crossing.getRevealSubStage() : null,
        arrivalPhase: crossing ? crossing.getArrivalPhase() : null,
        arrivalOpticalMix: crossing ? crossing.getArrivalOpticalMix() : null
      };
      window.__phase1cInstrumentation.events.push(entry);
      log(label, entry);
    }

    record("activate:dispatched");

    function tick() {
      const crossing = window.__mvCrossing;
      if (!crossing) {
        window.requestAnimationFrame(tick);
        return;
      }

      const phase = crossing.getPhase();
      const subStage = crossing.getRevealSubStage();
      const arrivalPhase = crossing.getArrivalPhase();

      if (phase !== lastPhase) {
        record(`materialPhase -> ${phase}`);
        lastPhase = phase;
      }
      if (subStage !== lastSubStage) {
        record(`revealSubStage -> ${subStage}`);
        lastSubStage = subStage;
      }
      if (arrivalPhase !== lastArrivalPhase) {
        record(`arrivalPhase -> ${arrivalPhase}`);
        lastArrivalPhase = arrivalPhase;
      }

      if (arrivalPhase === "stable") {
        // Phase 1C's frozen boundary: this is the already-approved Stable
        // Games visual state. Nothing above this line changed for Phase
        // 1D — the phase/subStage/arrivalPhase polling and every timing
        // value it observes is byte-identical to what Phase 1C measured.
        //
        // Phase 1D's entire addition starts here. The stable frame is
        // already painted and on screen (it has been continuously visible
        // since Arrival completed); nothing is hidden, faded, or replaced
        // before navigation. This adapter does not stop observing — it
        // stops polling material-engine.js (nothing more from it is
        // relevant) and instead performs one narrow handoff:
        window.__phase1cInstrumentation.arrivalStableAt = Math.round(performance.now() - activatedAt);
        log("arrivalPhase stable — beginning Phase 1D handoff", window.__phase1cInstrumentation);

        const markerWritten = writeHandoffMarker();
        window.__phase1cInstrumentation.handoffMarkerWritten = markerWritten;

        // Double rAF: the "stable" transition was observed inside a rAF
        // callback, which runs BEFORE the browser paints that frame. A
        // same-tick navigation risks the browser swapping documents before
        // ever compositing the fully-stable frame this handoff depends on
        // being the visitor's last-seen source frame. Waiting for two
        // further animation-frame callbacks guarantees a compositor paint
        // has occurred in between (the standard "wait for paint" pattern),
        // without adding any visible hold, animation, or synthetic delay —
        // it costs at most ~1-2 display frames, not a perceptible pause.
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            window.__phase1cInstrumentation.navigateInitiatedAt =
              Math.round(performance.now() - activatedAt);
            log("navigating to target document", { href: link.href });
            window.location.assign(link.href);
          });
        });
        return;
      }

      window.requestAnimationFrame(tick);
    }
    window.requestAnimationFrame(tick);
  }

  async function bootstrap(link) {
    if (bootstrapping || handedOff) {
      return;
    }
    bootstrapping = true;

    try {
      ensureStylesheet();
      ensureMarkup();
      ensurePrefetchHint(link); // Phase 1D: best-effort, isolated, no dependency
      await loadEngineScript();
      await waitForEngineReady();

      handedOff = true;
      const activateBtn = document.getElementById("mv-activate");
      const activatedAt = performance.now();
      activateBtn.click(); // the engine's own real, existing activation entry
                            // point — dispatched programmatically on behalf
                            // of the real click the visitor already made on
                            // the real [data-game-localization-entry] link.
      beginInstrumentation(activatedAt, link);
    } catch (error) {
      fallbackNavigate(link, error && error.message ? error.message : String(error));
    } finally {
      bootstrapping = false;
    }
  }

  // Capture-phase listener on document: fires before script.js's own
  // bubble-phase document click listener (which is what instantiates the
  // old ThresholdController) regardless of script tag order, because
  // capture-phase listeners on an ancestor always run before bubble-phase
  // listeners on that same ancestor for the same event. This is the entire
  // isolation mechanism — script.js is never read, imported, or modified.
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }
    const link = event.target.closest(ENTRY_SELECTOR);
    if (!(link instanceof HTMLAnchorElement)) {
      return;
    }
    if (!isStandardActivation(event, link)) {
      return; // modifier-key / new-tab / cross-origin clicks are left
               // completely alone, for both this adapter and the old system
    }

    window.__phase1cInstrumentation.clickedAt = performance.now();
    event.preventDefault();
    event.stopImmediatePropagation(); // blocks script.js's own document
                                       // click listener from ever running
                                       // for this event — the old
                                       // ThresholdController never starts
    log("gated entry activation intercepted", { href: link.href });
    bootstrap(link);
  }, true);
})();
