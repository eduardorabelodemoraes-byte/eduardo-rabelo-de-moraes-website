// experiment/liquid-atmosphere-gate1 — Gate 1 of the rebuilt post-Home
// passage, on top of Candidate A4's clean ENTRY architecture (Real Home,
// static canonical PNG captures, no html2canvas, no live DOM capture).
// The html2canvas/iframe/live-capture EXIT architecture explored by
// caf6d4c/0f1b700/995b1ba failed on real devices and is not present here
// in any form — this file was branched from validation/stable-games-v8@
// 44a11a4, which predates all of it.
//
// COMPLETE NO-OP unless the page is loaded with ?thresholdIntegration=1.
// Ungated behavior is byte-for-byte unchanged: no listeners, no DOM
// injection, no network requests, nothing.
//
// This file never touches C400/Crossing/Arrival physics, timing, shaders or
// choreography beyond what material-engine.js's own Gate 1 shader/state
// changes already describe. Every change in this file is adapter-side only.
//
//   ENTRY architecture (unchanged from A4) — no html2canvas, no runtime
//       DOM capture. Two canonical, prevalidated PNG captures of the real
//       Home page's Expertise section — threshold-integration/prebaked/
//       mv-home-desktop.png and mv-home-iphone.png — are supplied to the
//       frozen engine through the override seam A1 added:
//       window.__threshold_homeOverride. loadHomeOverride() loads them
//       exactly once per page lifetime, via a plain Image() load; nothing
//       recaptures or reuploads Home after that.
//
//   ENTRY prewarm timing (Gate 1 change) — armEagerPrewarm() starts the
//       frozen engine's initialize()/C400 prewarm as soon as this script
//       runs, no longer gated behind scrolling the Expertise section into
//       view (A4's armPrewarmObserver()). This is a TIMING change only:
//       the Home texture mechanism it warms up is the same single static
//       load described above. Canvas opacity stays 0 and pointer-events
//       stays none (material-harness.css, unchanged) throughout prewarm,
//       so the real, live Home DOM is the only thing a visitor sees or
//       can interact with until they actually click.
//
//   EXIT (Gate 1 change) — there is no EXIT in this Gate. A3/A4's
//       prefetchGamesDocument() and the handoff-marker + real
//       location.assign() navigation are both removed entirely: this
//       experiment ends at the new procedural atmosphere's held resting
//       state (arrivalPhase "stable" — see material-engine.js) and goes
//       no further. If Gate 1 validates on real devices, Gate 2 adds real
//       navigation from that same held state into Stable Games V8's own
//       new atmospheric pre-narrative entry point.
//
// Known, disclosed limitation carried into this file (see A2/A3/A4's own
// reports): the frozen engine uses ONE shared cover-fit reference aspect
// for the Home texture (manifestEntries[key].cssWidth/cssHeight). This
// file sets that reference to the canonical capture's own fixed viewport
// size per device class (1366x800 desktop, 390x844 mobile — the same
// sizes this repo's local validation harness already uses) rather than
// the visitor's live viewport, so cover-fit is exact only when the live
// viewport matches one of those two references.

(() => {
  "use strict";

  // launch/final-integration: production activation. The approved A4
  // Crossing is now the default experience for every visitor on the real
  // "Game Localization" link — no query parameter required or checked.
  // GATE_PARAM/gateActive are gone as a runtime check but every other line
  // below that reads `gateActive` is unchanged, so this is the only
  // behavioral edit in this file relative to frozen A4.
  // The current production Home link carries no special data attribute
  // (Phase 1G's retire commit removed it along with everything else) — it
  // is simply `<a class="expertise__link" href="game-localization/">`. To
  // avoid any index.html markup change beyond the one script tag, this
  // candidate targets the existing, real link by its actual href instead
  // of requiring a new attribute.
  const ENTRY_SELECTOR = 'a.expertise__link[href="game-localization/"]';
  const BASE = "threshold-integration/";
  const READY_TIMEOUT_MS = 8000;
  const READY_POLL_MS = 40;

  // A4 addition: fixed reference dimensions for the two canonical Home
  // captures (see prebaked/mv-home-desktop.png / mv-home-iphone.png).
  // These are the CSS-pixel viewport sizes the captures were taken at —
  // used only for updateCoverMapping()'s referenceAspect, the same field
  // A1/A2/A3 always populated from a live viewport reading.
  const HOME_REFERENCE = {
    desktop: { cssWidth: 1366, cssHeight: 800 },
    mobile: { cssWidth: 390, cssHeight: 844 }
  };

  const gateActive = true;

  let bootstrapping = false;
  let handedOff = false;
  // A4 addition: separate from bootstrapping/handedOff — tracks the
  // prewarm-only path (engine load + initialize(), no activate()) so the
  // observer trigger and the click handler can safely both call the same
  // idempotent readiness function without either one re-doing the other's
  // work or racing it.
  let engineReadyPromise = null;

  function log(label, detail) {
    // eslint-disable-next-line no-console
    console.info(`[a1] ${label}`, detail === undefined ? "" : detail);
  }

  window.__a1Instrumentation = {
    gateActive: true,
    clickedAt: null,
    prewarmStartedAt: null,
    prewarmReadyAt: null,
    activatedAt: null,
    events: [],
    fallback: null,
    atmosphereSettledAt: null,
    reentryEvents: []
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
    if (document.getElementById("a1-material-harness-css")) return;
    const link = document.createElement("link");
    link.id = "a1-material-harness-css";
    link.rel = "stylesheet";
    link.href = `${BASE}material-harness.css`;
    document.head.appendChild(link);
  }

  function ensureMarkup() {
    if (document.getElementById("mv-canvas")) return;
    const canvas = document.createElement("canvas");
    canvas.id = "mv-canvas";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);

    const controls = document.createElement("div");
    controls.id = "mv-controls";
    controls.hidden = true;
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

  // A4 addition: loads the two canonical, prevalidated Home captures —
  // same technique, same idempotent Image()-based loader, as
  // loadGamesOverride() below (unchanged from A3). Only the source files
  // differ. Both are plain <img> loads; the frozen engine's initialize()
  // accepts either an Image or a Canvas identically (see file-header
  // comment).
  function loadHomeOverride() {
    const load = (src) => new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`failed to load ${src}`));
      img.src = src;
    });
    return Promise.all([
      load(`${BASE}prebaked/mv-home-desktop.png`),
      load(`${BASE}prebaked/mv-home-iphone.png`)
    ]).then(([desktop, mobile]) => ({ desktop, mobile }));
  }

  // Loads the two approved Games prebaked textures from their real location
  // in this candidate (threshold-integration/prebaked/), so the frozen
  // engine's own hardcoded, document-root-relative GAMES_TEXTURES paths
  // never need to resolve correctly on their own. Unmodified checkpoint
  // image bytes — only the path they're fetched from differs, because this
  // candidate's copy of the engine lives one directory below the document
  // root. Unchanged from A3.
  function loadGamesOverride() {
    const load = (src) => new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`failed to load ${src}`));
      img.src = src;
    });
    return Promise.all([
      load(`${BASE}prebaked/mv-games-desktop.png`),
      load(`${BASE}prebaked/mv-games-iphone.png`)
    ]).then(([desktop, mobile]) => ({ desktop, mobile }));
  }

  // Gate 1: the EXIT prefetch hint (prefetchGamesDocument(), A3/A4) is
  // removed along with real navigation. This experiment never leaves
  // Home/Crossing — there is nothing on the far side to prefetch, and
  // issuing a same-origin resource hint for a document this Gate never
  // navigates to would be dead weight, not a genuine EXIT refinement.
  function loadEngineScript() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = "a1-material-engine";
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

  function beginInstrumentation(activatedAt) {
    window.__a1Instrumentation.activatedAt = activatedAt;
    let lastPhase = null, lastSubStage = null, lastArrivalPhase = null;

    function record(label) {
      const crossing = window.__mvCrossing;
      const entry = {
        label,
        tMs: Math.round(performance.now() - activatedAt),
        phase: crossing ? crossing.getPhase() : null,
        revealSubStage: crossing ? crossing.getRevealSubStage() : null,
        arrivalPhase: crossing ? crossing.getArrivalPhase() : null
      };
      window.__a1Instrumentation.events.push(entry);
      log(label, entry);
    }
    record("activate:dispatched");

    function tick() {
      const crossing = window.__mvCrossing;
      if (!crossing) { window.requestAnimationFrame(tick); return; }
      const phase = crossing.getPhase();
      const subStage = crossing.getRevealSubStage();
      const arrivalPhase = crossing.getArrivalPhase();
      if (phase !== lastPhase) { record(`materialPhase -> ${phase}`); lastPhase = phase; }
      if (subStage !== lastSubStage) { record(`revealSubStage -> ${subStage}`); lastSubStage = subStage; }
      if (arrivalPhase !== lastArrivalPhase) { record(`arrivalPhase -> ${arrivalPhase}`); lastArrivalPhase = arrivalPhase; }

      // Gate 1: no navigation. arrivalPhase "stable" (materialPhase
      // already "revealed", worldMix held at 1, the new procedural
      // atmosphere fully converged, and updateArrival()'s own
      // arrivalOpticalMix — unchanged, still purely refraction-calming —
      // pinned at its resting value) is this experiment's deliberate,
      // held endpoint: the atmosphere fully settled and breathing. There
      // is no handoff to hide in this Gate, because this Gate does not
      // leave Home/Crossing — so there is no marker to write and nothing
      // to navigate to. Instrumentation simply records the moment
      // arrival stabilizes and stops polling; the frozen engine keeps
      // rendering (ambient motion continues, per its own unchanged
      // "revealed holds indefinitely" contract) so a tester can observe
      // it breathe for as long as they like.
      if (arrivalPhase === "stable" && window.__a1Instrumentation.atmosphereSettledAt === null) {
        window.__a1Instrumentation.atmosphereSettledAt = Math.round(performance.now() - activatedAt);
        log("atmosphere settled (Gate 1 held endpoint — no navigation)", {
          atmosphereSettledAt: window.__a1Instrumentation.atmosphereSettledAt
        });
      }
      window.requestAnimationFrame(tick);
    }
    window.requestAnimationFrame(tick);
  }

  // A4 addition — replaces A1/A2/A3's bootstrap()'s capture step. Supplies
  // the two canonical images plus their fixed reference dimensions to the
  // exact same override seam the frozen engine already reads inside
  // initialize(); does not fetch or touch anything device/session-specific.
  function applyCanonicalHomeOverride(homeImages) {
    window.__threshold_homeOverride = { desktop: homeImages.desktop, mobile: homeImages.mobile };
    window.__MV_MANIFEST_INLINE__ = {
      desktop: { file: "prebaked/mv-home-desktop.png", cssWidth: HOME_REFERENCE.desktop.cssWidth, cssHeight: HOME_REFERENCE.desktop.cssHeight },
      mobile: { file: "prebaked/mv-home-iphone.png", cssWidth: HOME_REFERENCE.mobile.cssWidth, cssHeight: HOME_REFERENCE.mobile.cssHeight }
    };
  }

  // A4 addition — the shared, idempotent readiness path. Both the eager
  // prewarm trigger and the click handler call this same function;
  // whichever gets there first does the work, the other
  // just awaits the same in-flight promise. Loads the canonical Home/Games
  // images, sets the override seam, ensures markup/stylesheet exist (both
  // already idempotent, unchanged from A1/A2/A3), and loads+initializes
  // the frozen engine exactly once per page lifetime. Never calls
  // activate() — that remains the click handler's job alone.
  function ensureEngineReady() {
    if (engineReadyPromise) return engineReadyPromise;
    window.__a1Instrumentation.prewarmStartedAt = Math.round(performance.now());
    engineReadyPromise = (async () => {
      const [homeImages, gamesImages] = await Promise.all([
        loadHomeOverride(),
        loadGamesOverride()
      ]);
      applyCanonicalHomeOverride(homeImages);
      window.__threshold_gamesOverride = gamesImages;

      ensureStylesheet();
      ensureMarkup();
      // Reentry (Correction 3, unchanged from A2/A3): if the frozen engine
      // is already loaded and running in this page's memory
      // (window.__mvCrossing set on a prior activation within this same
      // page lifetime), do not load/execute material-engine.js a second
      // time.
      if (!window.__mvCrossing) {
        await loadEngineScript();
      }
      await waitForEngineReady();
      window.__a1Instrumentation.prewarmReadyAt = Math.round(performance.now());
    })();
    return engineReadyPromise;
  }

  // Gate 1 — eager prewarm trigger, timing-only change from A4's
  // Expertise-visibility-gated armPrewarmObserver(). This is approved
  // eager ENGINE warmup timing exactly as described in the pre-
  // implementation report: it starts the frozen engine's own idle-time
  // initialize()/C400 prewarm as early as page load, no longer gated
  // behind scrolling Expertise into view. It does NOT authorize, and does
  // NOT perform, any continuous recapture/reupload of Home — Home's
  // texture still comes from the exact same static, single-load
  // loadHomeOverride() -> applyCanonicalHomeOverride() call inside
  // ensureEngineReady() that already existed at 44a11a4, called at most
  // once per page lifetime, with no html2canvas, no live DOM capture, and
  // no repeated texImage2D/deleteTexture churn of any kind. Purely
  // additive: if this call fails for any reason, the click handler's own
  // ensureEngineReady() call below still performs the identical work on
  // the click path itself, same as A4 always did.
  function armEagerPrewarm() {
    ensureEngineReady().catch((error) => {
      // Swallow here — this is a best-effort prewarm. Any real failure
      // surfaces identically through the click handler's own
      // ensureEngineReady() call and its existing fallbackNavigate() path.
      log("eager prewarm failed (non-fatal, click path will retry)", error && error.message ? error.message : String(error));
    });
  }

  async function bootstrap(link) {
    if (bootstrapping || handedOff) return;
    bootstrapping = true;
    try {
      await ensureEngineReady();

      handedOff = true;
      const activateBtn = document.getElementById("mv-activate");
      const activatedAt = performance.now();
      activateBtn.click();
      beginInstrumentation(activatedAt);
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

  // Correction 3 — reentry / Back. The first passage must not permanently
  // latch this candidate: a visitor who completes a Crossing, lands on the
  // real Games page, then presses Back is normally restored straight from
  // the browser's bfcache — this whole script's memory (bootstrapping,
  // handedOff, window.__mvCrossing, the WebGL context, the DOM) comes back
  // exactly as it was frozen, nothing re-executes. Without this listener,
  // handedOff would still read true and bootstrap() would silently no-op
  // forever on this restored page instance. Unchanged from A2/A3.
  //
  // pageshow fires on every load, including the very first one (with
  // event.persisted === false there) — this handler only acts on an
  // actual bfcache restore, so the first activation's own flow above is
  // completely unaffected.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;

    const wasHandedOff = handedOff;
    const wasBootstrapping = bootstrapping;
    bootstrapping = false;
    handedOff = false;

    const crossing = window.__mvCrossing;
    let resetInvoked = false;
    // "Left active/post-activation" per the frozen engine's own public
    // surface: getPhase() !== "solid" (its resting/idle value, and the
    // exact value reset() itself restores).
    //
    // window.__mvCrossing is a read-only verification surface — it does
    // not expose reset() directly. The only existing, already-wired path
    // to the engine's real reset() function is the same one a visitor's
    // own click already uses: the #mv-reset button's click listener
    // (resetBtn.addEventListener("click", reset), unchanged in the frozen
    // engine). This mirrors exactly how bootstrap() below already invokes
    // activate() — via activateBtn.click(), never by calling an internal
    // function directly. No new reset behavior is added to the frozen
    // engine; this only triggers the existing one the same way a real
    // click would.
    const resetBtn = document.getElementById("mv-reset");
    if (crossing && typeof crossing.getPhase === "function" && crossing.getPhase() !== "solid" &&
        resetBtn && !resetBtn.disabled) {
      resetBtn.click();
      resetInvoked = true;
    }

    window.__a1Instrumentation.reentryEvents.push({
      at: Date.now(),
      wasHandedOff,
      wasBootstrapping,
      engineWasPresent: Boolean(crossing),
      resetInvoked
    });
    log("pageshow bfcache restore — reentry latches cleared", {
      wasHandedOff, resetInvoked
    });
  });
})();
