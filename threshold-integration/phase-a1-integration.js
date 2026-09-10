// Integration Candidate A4 — production-integration strategy change on top
// of Candidate A3 (Real Home -> approved Threshold portal -> real Game
// Localization page). A3's EXIT refinement (prefetchGamesDocument()) is
// carried forward unchanged. This candidate replaces A3's ENTRY story:
//
// COMPLETE NO-OP unless the page is loaded with ?thresholdIntegration=1.
// Ungated behavior is byte-for-byte unchanged: no listeners, no DOM
// injection, no network requests, nothing.
//
// This file never touches C400/Crossing/Arrival physics, timing, shaders or
// choreography. Every change in this candidate is adapter-side only.
//
//   (6) ENTRY architecture change (this candidate) — removes html2canvas
//       and the runtime, click-time DOM capture it performed
//       (captureLiveHomeViewport(), A1/A2/A3's Boundary A technique)
//       entirely from the critical path. In its place, two new canonical,
//       prevalidated PNG captures of the real Home page's Expertise
//       section — threshold-integration/prebaked/mv-home-desktop.png and
//       mv-home-iphone.png, generated once, offline, from the real
//       unmodified repo (see prebaked/README-a4-capture.md) — are supplied
//       to the frozen engine through the SAME override seam Candidate A1
//       already added and Candidate A3's Games-side loadGamesOverride()
//       already exercises: window.__threshold_homeOverride. Per
//       material-engine.js's own initialize() (`const override =
//       window.__threshold_homeOverride && window.__threshold_homeOverride
//       [key]; const image = override ? override : await
//       loadImage(def.file);`), the engine cannot distinguish a preloaded
//       Image() from a live-captured canvas — both are plain
//       CanvasImageSource values accepted identically by uploadTexture().
//       Nothing in material-engine.js changes or needs to change.
//
//       Because the Home texture source is now a static, preloadable asset
//       instead of a value that can only exist at the instant of a real
//       click, the ENTRY prewarm A3 investigated and explicitly declined
//       to implement (A3's own file-header comment, preserved in git
//       history) is now safe and is implemented here: as soon as the
//       Expertise section (where the Game Localization link lives) enters
//       the viewport, this adapter loads the canonical Home/Games images,
//       loads material-engine.js, and runs the frozen engine's entire
//       initialize() (WebGL context, shader compile, texture upload, C400
//       prewarm scheduling) — all while canvas opacity is 0 and
//       pointer-events is none (material-harness.css, unchanged), so the
//       real, live Home DOM is the only thing the visitor ever sees or can
//       interact with until they actually click. On click, if prewarm has
//       already completed, activation is immediate (activateBtn.click()
//       synchronously) with zero further async work on the click path
//       itself. If prewarm has not yet completed (click arriving unusually
//       fast after Expertise becomes visible), the same idempotent
//       ensureEngineReady() path click triggers is exactly what the
//       observer trigger already started — click simply awaits whatever
//       remains, same as A1/A2/A3 always did, still with html2canvas and
//       its runtime capture removed either way.
//
//       Accepted, disclosed trade-off (explicit product decision, not an
//       oversight): the canonical image is captured once, offline, with
//       the Expertise section scrolled fully into view — the same
//       composition the OLD live capture always produced, since a visitor
//       cannot click a link that is not on screen. It does NOT reflect an
//       individual visitor's exact live scroll offset, in-between scroll
//       position, or any dynamic/session-specific Home state at their
//       actual moment of click. Home's Expertise section carries no
//       dynamic data, so in the overwhelming majority of real activations
//       this is visually indistinguishable from the old live capture; the
//       one class of visit where it would differ is a click landing at an
//       unusual, non-Expertise-centered scroll position, which the old
//       per-click capture could represent and this canonical one cannot.
//
//   (4) EXIT refinement (unchanged from A3) — prefetchGamesDocument():
//       during the Crossing, once the frozen engine's own materialPhase
//       first leaves "solid", issue a same-origin <link rel="prefetch">
//       hint for the real /game-localization/ document.
//
// Known, disclosed limitation carried into this candidate (see A2/A3's own
// reports): the frozen engine uses ONE shared cover-fit reference aspect
// for both the Home and Games textures (manifestEntries[key].cssWidth/
// cssHeight). This candidate sets that reference to the canonical capture's
// own fixed viewport size per device class (1366x800 desktop, 390x844
// mobile — the same sizes this repo's local validation harness already
// uses) rather than the visitor's live viewport, so cover-fit is exact only
// when the live viewport matches one of those two references and shows the
// same letterboxing/cropping characteristic CHOREOGRAPHY.txt already
// documents as accepted for the approved experiment otherwise.

(() => {
  "use strict";

  const GATE_PARAM = "thresholdIntegration";
  // The current production Home link carries no special data attribute
  // (Phase 1G's retire commit removed it along with everything else) — it
  // is simply `<a class="expertise__link" href="game-localization/">`. To
  // avoid any index.html markup change beyond the one script tag, this
  // candidate targets the existing, real link by its actual href instead
  // of requiring a new attribute.
  const ENTRY_SELECTOR = 'a.expertise__link[href="game-localization/"]';
  // A4 addition: the prewarm trigger. The real "Game Localization" link
  // lives inside this section (see index.html) — a visitor cannot activate
  // the entry without this section having already been scrolled into view,
  // so it is both a safe and a maximally-early prewarm signal.
  const PREWARM_TRIGGER_SELECTOR = "#expertise";
  const BASE = "threshold-integration/";
  const READY_TIMEOUT_MS = 8000;
  const READY_POLL_MS = 40;

  const HANDOFF_STORAGE_KEY = "phase1dThresholdHandoff";
  const HANDOFF_MARKER_VERSION = 1;
  const HANDOFF_MARKER_SOURCE = "threshold-integration-phase1d";

  // A4 addition: fixed reference dimensions for the two canonical Home
  // captures (see prebaked/mv-home-desktop.png / mv-home-iphone.png).
  // These are the CSS-pixel viewport sizes the captures were taken at —
  // used only for updateCoverMapping()'s referenceAspect, the same field
  // A1/A2/A3 always populated from a live viewport reading.
  const HOME_REFERENCE = {
    desktop: { cssWidth: 1366, cssHeight: 800 },
    mobile: { cssWidth: 390, cssHeight: 844 }
  };

  let gateActive = false;
  try {
    gateActive = new URLSearchParams(window.location.search).get(GATE_PARAM) === "1";
  } catch {
    gateActive = false;
  }

  if (!gateActive) {
    return;
  }

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
    arrivalStableAt: null,
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

  // A3 Refinement (4), unchanged — EXIT prefetch. A passive, same-origin
  // resource hint only: does not embed the live Games DOM, does not
  // iframe it, does not create a second live document tree, and does not
  // touch the A2 handoff architecture (marker + double-rAF + ordinary
  // location.assign() below, all unchanged). Idempotent by element id, so
  // a second Crossing within the same page lifetime (reentry) is a
  // harmless no-op rather than a duplicate hint.
  function prefetchGamesDocument(link, activatedAt) {
    if (document.getElementById("a1-games-prefetch")) return;
    const startedAt = Math.round(performance.now() - activatedAt);
    window.__a1Instrumentation.prefetchStartedAt = startedAt;
    log("issuing games-page prefetch hint", { href: link.href, startedAt });

    const hint = document.createElement("link");
    hint.id = "a1-games-prefetch";
    hint.rel = "prefetch";
    hint.href = link.href;
    // Best-effort only: <link rel="prefetch"> load/error firing is not
    // guaranteed across browsers, and this adapter never blocks or gates
    // navigation on it — the ordinary same-origin navigation at
    // Arrival-stable proceeds identically whether or not this fires.
    hint.onload = () => {
      window.__a1Instrumentation.prefetchCompletedAt = Math.round(performance.now() - activatedAt);
      window.__a1Instrumentation.prefetchOutcome = "loaded";
    };
    hint.onerror = () => {
      window.__a1Instrumentation.prefetchOutcome = "error";
    };
    document.head.appendChild(hint);
  }

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

  function beginInstrumentation(activatedAt, link) {
    window.__a1Instrumentation.activatedAt = activatedAt;
    let lastPhase = null, lastSubStage = null, lastArrivalPhase = null;
    let prefetchIssued = false;

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

      // A3 Refinement (4): fire the EXIT prefetch hint as early as
      // possible — the first tick where materialPhase has left "solid" —
      // to give the browser the maximum possible lead time (the entire
      // remaining Crossing + Arrival duration) to warm its cache for the
      // real /game-localization/ document before the unchanged A2
      // handoff navigates to it. One-shot per activation; harmless no-op
      // on a page that already has the hint element (see
      // prefetchGamesDocument's own idempotency guard).
      if (!prefetchIssued && phase && phase !== "solid") {
        prefetchIssued = true;
        prefetchGamesDocument(link, activatedAt);
      }

      if (arrivalPhase === "stable") {
        window.__a1Instrumentation.arrivalStableAt = Math.round(performance.now() - activatedAt);
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
      window.requestAnimationFrame(tick);
    }
    window.requestAnimationFrame(tick);
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

  // A4 addition — the shared, idempotent readiness path. Both the
  // Expertise-visibility prewarm trigger and the click handler call this
  // same function; whichever gets there first does the work, the other
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

  // A4 addition — prewarm trigger. Fires ensureEngineReady() as soon as
  // the Expertise section (which contains the real Game Localization
  // link) is at all visible, giving the frozen engine's own idle-time C400
  // prewarm (schedulePrewarmC400(), unchanged/frozen) real idle time to
  // complete before any click, on top of removing html2canvas/runtime
  // capture from the critical path entirely. Purely additive: if this
  // observer never fires (e.g. a visitor reaches the link some other way)
  // the click handler's own ensureEngineReady() call below still performs
  // the identical work on the click path itself, same as A1/A2/A3 always
  // did minus html2canvas.
  function armPrewarmObserver() {
    const target = document.querySelector(PREWARM_TRIGGER_SELECTOR);
    if (!target || typeof window.IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.disconnect();
          ensureEngineReady().catch((error) => {
            // Swallow here — this is a best-effort prewarm. Any real
            // failure surfaces identically through the click handler's
            // own ensureEngineReady() call and its existing
            // fallbackNavigate() path.
            log("prewarm failed (non-fatal, click path will retry)", error && error.message ? error.message : String(error));
          });
          return;
        }
      }
    }, { rootMargin: "0px", threshold: 0 });
    observer.observe(target);
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

  armPrewarmObserver();

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
