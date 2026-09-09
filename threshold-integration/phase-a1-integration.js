// Integration Candidate A3 — minimal integration-boundary refinement of
// Candidate A2 (Real Home -> approved Threshold portal -> real Game
// Localization page).
//
// COMPLETE NO-OP unless the page is loaded with ?thresholdIntegration=1.
// Ungated behavior is byte-for-byte unchanged: no listeners, no DOM
// injection, no network requests, nothing.
//
// This file never touches C400/Crossing/Arrival physics, timing, shaders or
// choreography. Candidate A2 already does three things (Boundary A capture,
// Boundary B handoff, reentry/Back correction) — see the per-function
// comments below, all unchanged from A2. Candidate A3 adds exactly ONE
// integration-boundary refinement on top of A2, and explicitly does NOT add
// a second one that was investigated and found architecturally blocked:
//
//   (4) EXIT refinement (implemented) — prefetchGamesDocument(): during the
//       Crossing, once the frozen engine's own materialPhase first leaves
//       "solid" (i.e. as early as possible after activate(), while
//       Crossing/Arrival is still running), issue a same-origin
//       <link rel="prefetch"> hint for the real /game-localization/
//       document. This gives the browser the entire remaining Crossing +
//       Arrival duration (~8-9s) to warm its own HTTP cache for that
//       document's resources, so that the ordinary same-origin navigation
//       already used at Arrival-stable (unchanged from A2: marker + two
//       rAFs + location.assign()) resolves to first real paint faster.
//       Nothing about the handoff architecture, the double-rAF paint
//       guarantee, or the final optical frame changes — this only adds a
//       passive resource hint earlier.
//
//   (5) ENTRY refinement (investigated, NOT implemented — STOP condition
//       met) — prewarming html2canvas + material-engine.js before the
//       click, triggered by the Expertise section becoming visible, was
//       the assigned scope. It was not implemented, on hard evidence, not
//       assumption:
//         - material-engine.js's initialize() uploads the Home texture
//           into WebGL EXACTLY ONCE, synchronously, at script-execution
//           time (see its texture-loading block), keyed on whatever
//           window.__threshold_homeOverride happens to contain at that
//           instant. There is no re-upload/re-initialize path anywhere in
//           the frozen engine's public surface (__mvCrossing, __mvDebug,
//           bindControls()) that this adapter is permitted to call.
//         - This repository ships no prebaked Home fallback images
//           (no prebaked/mv-home-desktop.png, no prebaked/mv-home-iphone
//           .png) and no prebaked/mv-manifest.json. Loading
//           material-engine.js before this adapter has already supplied
//           window.__MV_MANIFEST_INLINE__ and window.__threshold_
//           homeOverride does not degrade gracefully to a placeholder —
//           it 404s loadManifest()'s fetch and/or loadImage()'s Home
//           fetch, which throws inside initialize() before the render
//           loop ever starts.
//         - The only way to avoid that 404 is to run captureLiveHome
//           Viewport() itself at Expertise-visible time, before the real
//           click — but because texture upload cannot be redone later,
//           whatever viewport/scroll state exists at THAT moment would be
//           permanently baked into the WebGL texture, even if the visitor
//           keeps scrolling before actually clicking. That would violate
//           the explicit requirement that "the actual Home capture must
//           still represent the visitor's real activation state" and the
//           ENTRY SAFETY INVARIANT "same first visible material frame
//           semantics" — a correctness regression, not a timing
//           improvement.
//         - Prewarming ONLY html2canvas.min.js (the one piece with no
//           such coupling) was also evaluated and excluded: the boundary
//           diagnosis measured html2canvas's own script-insert-to-onload
//           cost at ~20ms, not the ~433ms dominant stall (which overlaps
//           material-engine.js's own load/WebGL-init) — prewarming it
//           alone would not materially improve the real click boundary,
//           and the task's own instruction is explicit: if a prewarm does
//           not materially help, do not keep the added complexity.
//       Per this task's own explicit instruction ("If the frozen engine's
//       current initialization contract makes safe prewarm impossible
//       without modifying frozen behavior, STOP and report that rather
//       than forcing it"), this refinement was stopped rather than forced.
//       loadHtml2Canvas()/loadEngineScript() below remain byte-for-byte
//       identical to A2 — both still load on the click path only.
//
// Known, disclosed limitation carried into this candidate (see the
// report's KNOWN ISSUES section): the frozen engine uses ONE shared
// cover-fit reference aspect for both the Home and Games textures
// (manifestEntries[key].cssWidth/cssHeight). This adapter sets that
// reference to the visitor's actual live viewport so Home fits exactly;
// the approved Games prebake (captured at the fixed canonical viewport)
// then inherits that same reference, so it will only cover-fit perfectly
// when the live viewport happens to match a canonical size, and will show
// letterboxing/cropping differences otherwise — the same class of
// viewport-dependent behavior CHOREOGRAPHY.txt already documented as an
// accepted characteristic of the approved experiment, not a new defect
// category.

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
  const BASE = "threshold-integration/";
  const HTML2CANVAS_SRC = `${BASE}html2canvas.min.js`;
  const READY_TIMEOUT_MS = 8000;
  const READY_POLL_MS = 40;

  const HANDOFF_STORAGE_KEY = "phase1dThresholdHandoff";
  const HANDOFF_MARKER_VERSION = 1;
  const HANDOFF_MARKER_SOURCE = "threshold-integration-phase1d";

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

  function log(label, detail) {
    // eslint-disable-next-line no-console
    console.info(`[a1] ${label}`, detail === undefined ? "" : detail);
  }

  window.__a1Instrumentation = {
    gateActive: true,
    clickedAt: null,
    captureMs: null,
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

  // Loads html2canvas from the vendored local file only (Correction 1).
  // No CDN, no npm — a plain <script> tag pointed at this directory's own
  // copy. Idempotent: on reentry (second activation within the same page
  // lifetime — see the pageshow listener below) the library is already in
  // memory, so this is a harmless no-op the second time.
  function loadHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = "a1-html2canvas";
      script.src = HTML2CANVAS_SRC;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("html2canvas.min.js failed to load"));
      document.body.appendChild(script);
    });
  }

  // Boundary A — the html2canvas-based technique proven in the isolated
  // Boundary A test, applied directly to the real, currently-live document
  // (no separate load/serve step needed: we are already on the real Home).
  // Captures only the CURRENTLY VISIBLE viewport window at the visitor's
  // actual scroll position, at actual dpr.
  //
  // Recipe, exactly as proven: call html2canvas with NO x/y/width/height/
  // scrollX/scrollY/windowWidth/windowHeight overrides — letting it
  // auto-detect the full, currently-scrolled live document (this mode does
  // not truncate, unlike the SVG-foreignObject technique Candidate A1
  // used) — then crop the visible viewport window out of that full canvas
  // with a plain Canvas 2D drawImage, using the real window.scrollY and
  // devicePixelRatio.
  async function captureLiveHomeViewport() {
    const t0 = performance.now();

    const dpr = window.devicePixelRatio || 1;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const scrollY = window.scrollY;

    const fullCanvas = await window.html2canvas(document.documentElement, {
      scale: dpr,
      useCORS: true,
      backgroundColor: null,
      logging: false,
      // Correction 2 — capture-only underline fix. The real, live Home
      // never shows this link underlined (its live computed state is
      // text-decoration: none); html2canvas's own text-decoration handling
      // renders it underlined in the rasterized clone (confirmed in the
      // isolated proof, all 4 viewport cases). Corrected ONLY inside this
      // disposable cloned document, via html2canvas's own clone hook —
      // never touches the real DOM, the real CSS, or index.html.
      onclone: (clonedDocument) => {
        const clonedLink = clonedDocument.querySelector(ENTRY_SELECTOR);
        if (clonedLink) {
          clonedLink.style.textDecoration = "none";
        }
      }
    });

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = Math.round(viewportW * dpr);
    cropCanvas.height = Math.round(viewportH * dpr);
    cropCanvas.getContext("2d").drawImage(
      fullCanvas,
      0, Math.round(scrollY * dpr), cropCanvas.width, cropCanvas.height,
      0, 0, cropCanvas.width, cropCanvas.height
    );

    window.__a1Instrumentation.captureMs = performance.now() - t0;

    return { canvas: cropCanvas, cssWidth: viewportW, cssHeight: viewportH };
  }

  // Loads the two approved Games prebaked textures from their real location
  // in this candidate (threshold-integration/prebaked/), so the frozen
  // engine's own hardcoded, document-root-relative GAMES_TEXTURES paths
  // never need to resolve correctly on their own. Unmodified checkpoint
  // image bytes — only the path they're fetched from differs, because this
  // candidate's copy of the engine lives one directory below the document
  // root.
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

  // A3 Refinement (4) — EXIT prefetch. A passive, same-origin resource
  // hint only: does not embed the live Games DOM, does not iframe it, does
  // not create a second live document tree, and does not touch the A2
  // handoff architecture (marker + double-rAF + ordinary location.assign()
  // below, all unchanged). Idempotent by element id, so a second Crossing
  // within the same page lifetime (reentry) is a harmless no-op rather
  // than a duplicate hint.
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

  function writeHandoffMarker() {
    const marker = { version: HANDOFF_MARKER_VERSION, source: HANDOFF_MARKER_SOURCE, stableAt: Date.now() };
    try {
      window.sessionStorage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(marker));
      return true;
    } catch {
      return false;
    }
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

  async function bootstrap(link) {
    if (bootstrapping || handedOff) return;
    bootstrapping = true;
    try {
      await loadHtml2Canvas();
      const captured = await captureLiveHomeViewport();

      // Both TEXTURES keys point at the same live-captured canvas — only
      // the active key (selected by the frozen engine's own
      // selectTextureKey()) is ever actually sampled, so this only needs
      // to be correct for whichever key is currently active; the inactive
      // key's copy is unused but harmless.
      window.__threshold_homeOverride = { desktop: captured.canvas, mobile: captured.canvas };

      // Reference aspect for cover-fit set to the visitor's ACTUAL live
      // viewport, so Home fits with zero cropping at the moment of
      // activation. See file-header comment: this is shared with Games'
      // own cover-fit by the frozen engine's design, which is this
      // candidate's one disclosed, not-yet-resolved limitation.
      window.__MV_MANIFEST_INLINE__ = {
        desktop: { file: "prebaked/mv-home-desktop.png", cssWidth: captured.cssWidth, cssHeight: captured.cssHeight, dpr: window.devicePixelRatio || 1, scrollY: window.scrollY },
        mobile: { file: "prebaked/mv-home-iphone.png", cssWidth: captured.cssWidth, cssHeight: captured.cssHeight, dpr: window.devicePixelRatio || 1, scrollY: window.scrollY }
      };

      window.__threshold_gamesOverride = await loadGamesOverride();

      ensureStylesheet();
      ensureMarkup();
      // Reentry (Correction 3): if the frozen engine is already loaded and
      // running in this page's memory (window.__mvCrossing set on a prior
      // activation within this same page lifetime — the normal case after
      // a bfcache restore, since nothing unloaded), do not load/execute
      // material-engine.js a second time: that would re-run its one-shot
      // setup (bindControls(), WebGL context creation, etc.) on top of
      // already-initialized state. Reuse the existing engine instance and
      // go straight to waitForEngineReady(), which the pageshow handler
      // below has already put back into a ready state via the engine's
      // own existing reset().
      if (!window.__mvCrossing) {
        await loadEngineScript();
      }
      await waitForEngineReady();

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

  // Correction 3 — reentry / Back. The first passage must not permanently
  // latch this candidate: a visitor who completes a Crossing, lands on the
  // real Games page, then presses Back is normally restored straight from
  // the browser's bfcache — this whole script's memory (bootstrapping,
  // handedOff, window.__mvCrossing, the WebGL context, the DOM) comes back
  // exactly as it was frozen, nothing re-executes. Without this listener,
  // handedOff would still read true and bootstrap() would silently no-op
  // forever on this restored page instance.
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
