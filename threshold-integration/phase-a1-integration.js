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

  // seamless-crossing experiment additions. This whole block, and every
  // function below marked "seamless-crossing", is new in this experiment;
  // nothing above this point is touched. The marker/double-rAF/
  // location.assign() exit path a few functions down is left completely
  // intact and still runs, unmodified, as the fallback whenever any part
  // of the seamless path below isn't ready — see beginInstrumentation().
  const GAMES_IFRAME_ID = "mv-games-frame";
  // material-engine.js's own selectTextureKey() threshold (window.
  // innerWidth <= 700 ? "mobile" : "desktop") — reused here verbatim
  // because reuploadHomeTexture() writes into the SAME textureObjects map
  // keyed by that exact function's output. Intentionally NOT the same
  // number as game-localization/script.js's isMobile() (640) — that is a
  // different threshold for a different page/purpose.
  const HOME_TEXTURE_MOBILE_MAX_WIDTH = 700;
  const LIVE_CAPTURE_DEBOUNCE_MS = 120;

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

  // seamless-crossing experiment additions — mirror engineReadyPromise's
  // idempotency pattern for the two new prewarm resources.
  let gamesFrameReadyPromise = null;
  let html2canvasLoadPromise = null;
  let latestLiveHomeCapture = null; // {canvas, capturedAt} | null
  let liveCaptureInFlight = false;
  let liveCaptureDebounceTimer = null;
  let liveCaptureDisarmed = false;

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
    prefetchOutcome: null,
    seamlessHandoffUsed: null
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

  // ======================================================================
  // seamless-crossing experiment — everything from here to
  // beginInstrumentation() below is new. Two independent additions:
  //
  //   (A) Live Home texture refresh (fixes hitch 1: a small snap at
  //       activate(), immediately after clicking). Root cause: the Home
  //       texture is uploaded into WebGL exactly once, at prewarm time,
  //       from either a canonical fixed-scroll PNG or a one-shot capture —
  //       both go stale the moment the visitor scrolls again before
  //       clicking, and activate()'s live-DOM-to-canvas swap has no
  //       transition, so any mismatch is an instant, visible snap.
  //       reuploadHomeTexture() (material-engine.js addition, above) makes
  //       it safe to keep that texture live: html2canvas captures the
  //       visitor's actual current viewport, debounced on scroll/resize so
  //       the (relatively costly) rasterization never runs on the click's
  //       critical path — exactly the performance concern Candidate A3's
  //       own file-header comment (preserved in git history) raised
  //       against doing this at click time. The GPU re-upload itself is
  //       cheap (one texImage2D of an already-rasterized canvas) and is
  //       safe to do synchronously.
  //
  //   (B) Prewarmed Games surface (fixes hitch 2: a small hitch at the end,
  //       when Crossing/Arrival becomes the real page). Root cause: the
  //       exit path is a real cross-document navigation
  //       (window.location.assign) — even with the existing prefetch hint,
  //       the browser still has to tear down Home's document (destroying
  //       its WebGL context) and construct, parse, and paint a new one
  //       from scratch, which is not something a resource hint alone can
  //       make imperceptible. ensureGamesFrameReady() loads the real,
  //       unmodified game-localization/index.html into a same-origin
  //       iframe during the same Expertise-intersection prewarm window
  //       already used for the engine — kept fully invisible/inert
  //       (opacity 0, pointer-events none, inert) the entire time, so no
  //       visitor ever sees or can reach it before Arrival is done. Because
  //       it is loaded and settles seconds before it is ever revealed, its
  //       nav-color transition, fonts, and layout are already finished by
  //       reveal time — it is not "instant" the way the canvas is, it is
  //       just already old news by the time anyone looks at it. Revealing
  //       it is a single opacity/pointer-events toggle between two already
  //       -painted layers (see material-harness.css), paired with
  //       history.pushState() so the address bar and back button behave
  //       correctly without an actual document load.
  //
  // Both are strictly additive and strictly best-effort: if either fails
  // or is not ready by the time it is needed, the exact original,
  // previously-approved mechanism (canonical/whatever-was-last-uploaded
  // texture; marker + double-rAF + location.assign()) is what runs —
  // neither addition can make a real activation worse than it already was.
  // ======================================================================

  function loadHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve();
    if (html2canvasLoadPromise) return html2canvasLoadPromise;
    html2canvasLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = "a1-html2canvas";
      script.src = `${BASE}html2canvas.min.js`;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("html2canvas.min.js failed to load"));
      document.body.appendChild(script);
    });
    return html2canvasLoadPromise;
  }

  // Opportunistic, synchronous, cheap: pushes whatever the latest live
  // capture is into the already-initialized engine's Home texture. No-op
  // (silently) if the engine isn't initialized yet or no capture exists
  // yet — the canonical-PNG texture initialize() already uploaded remains
  // in place either way, so this is purely additive freshness, never a
  // correctness requirement.
  function refreshHomeTextureIfPossible() {
    // Disarmed means activation has begun (or is imminent) — never swap
    // the live GL texture once the crossing may be running. See
    // disarmLiveCaptureRefresher() for why this guard has to be checked
    // again here, not just at the scroll/resize listener boundary: a
    // capture already in flight when disarm fires must still be blocked
    // from reaching the GPU after it resolves.
    if (liveCaptureDisarmed) return;
    if (!latestLiveHomeCapture) return;
    if (!window.__mvDebug || typeof window.__mvDebug.reuploadHomeTexture !== "function") return;
    const key = window.innerWidth <= HOME_TEXTURE_MOBILE_MAX_WIDTH ? "mobile" : "desktop";
    window.__mvDebug.reuploadHomeTexture(latestLiveHomeCapture.canvas, key);
  }

  // The html2canvas-based technique A1—A3 proved for a click-time capture
  // (captureLiveHomeViewport(), preserved in git history), reused here
  // unchanged in its capture/crop logic — only WHEN it runs differs (see
  // scheduleLiveCaptureRefresh() below, not the click path). Captures only
  // the currently-visible viewport window at the visitor's actual scroll
  // position and actual dpr.
  async function refreshLiveHomeCapture() {
    if (liveCaptureDisarmed) return;
    if (liveCaptureInFlight) return;
    liveCaptureInFlight = true;
    try {
      await loadHtml2Canvas();
      const dpr = window.devicePixelRatio || 1;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const scrollY = window.scrollY;

      const fullCanvas = await window.html2canvas(document.documentElement, {
        scale: dpr,
        useCORS: true,
        backgroundColor: null,
        logging: false,
        onclone: (clonedDocument) => {
          const clonedLink = clonedDocument.querySelector(ENTRY_SELECTOR);
          if (clonedLink) clonedLink.style.textDecoration = "none";
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

      latestLiveHomeCapture = { canvas: cropCanvas, capturedAt: performance.now() };
      refreshHomeTextureIfPossible();
    } catch (error) {
      log("live Home capture refresh failed (non-fatal — canonical/last-known texture stays in use)", error && error.message ? error.message : String(error));
    } finally {
      liveCaptureInFlight = false;
    }
  }

  function scheduleLiveCaptureRefresh() {
    if (liveCaptureDisarmed) return;
    if (liveCaptureDebounceTimer) window.clearTimeout(liveCaptureDebounceTimer);
    liveCaptureDebounceTimer = window.setTimeout(() => {
      liveCaptureDebounceTimer = null;
      refreshLiveHomeCapture();
    }, LIVE_CAPTURE_DEBOUNCE_MS);
  }

  function armLiveCaptureRefresher() {
    window.addEventListener("scroll", scheduleLiveCaptureRefresh, { passive: true });
    window.addEventListener("resize", scheduleLiveCaptureRefresh, { passive: true });
    refreshLiveHomeCapture(); // first capture immediately, don't wait for a scroll event
  }

  // Root-cause fix for a real hitch-1 regression this pass introduced and
  // then found in validation (mobile, high-DPR): activate()'s own
  // scroll-lock reflow (material-engine.js locks scroll via
  // position:fixed + a negative `top` offset the instant it runs) fires a
  // native scroll/resize event. Without this guard that event re-arms
  // scheduleLiveCaptureRefresh(), which — 120ms later, now WELL into the
  // crossing — kicks off a full-page html2canvas rasterization and then
  // calls reuploadHomeTexture(), deleting and replacing the GL texture
  // the render loop is actively binding and drawing every frame. On this
  // environment's software-rendered WebGL that race reliably produced a
  // fully black composited frame (confirmed via before/after byte-identical
  // repro across multiple runs, and absent entirely on baseline code and
  // with only this refresher's listeners disabled — see validation notes).
  // The fix is to make it structurally impossible for a capture to reach
  // the GPU once activation has begun, not to delay or debounce around the
  // symptom: disarm the refresher as the very first synchronous action in
  // bootstrap(), before activateBtn.click() ever runs, so scroll-lock's own
  // reflow event lands on listeners that are already gone.
  function disarmLiveCaptureRefresher() {
    if (liveCaptureDisarmed) return;
    liveCaptureDisarmed = true;
    window.removeEventListener("scroll", scheduleLiveCaptureRefresh);
    window.removeEventListener("resize", scheduleLiveCaptureRefresh);
    if (liveCaptureDebounceTimer) {
      window.clearTimeout(liveCaptureDebounceTimer);
      liveCaptureDebounceTimer = null;
    }
  }

  // Loads the real, unmodified game-localization/index.html into a
  // same-origin, fully invisible/inert iframe, and waits for its script.js
  // (loaded with `defer`, same as always) to reach the point where it
  // exposes window.__embeddedRelease — i.e. its "embedded prewarm" branch
  // (game-localization/script.js addition) has established the exact same
  // anchor state (#world visible, correct nav, .narr pre-reveal) the
  // direct-navigation path reaches after its own double-rAF gate, and is
  // now just waiting to be told when to release the narrative reveal.
  function ensureGamesFrameReady() {
    if (gamesFrameReadyPromise) return gamesFrameReadyPromise;
    gamesFrameReadyPromise = (async () => {
      const link = document.querySelector(ENTRY_SELECTOR);
      if (!link) throw new Error("entry link not found for games iframe prewarm");

      const frame = document.createElement("iframe");
      frame.id = GAMES_IFRAME_ID;
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.inert = true; // excludes the whole subtree from focus/AT while hidden; cleared on reveal
      const url = new URL(link.href, window.location.href);
      url.searchParams.set("embeddedPrewarm", "1");
      frame.src = url.href;

      await new Promise((resolve, reject) => {
        frame.addEventListener("load", function onLoad() {
          frame.removeEventListener("load", onLoad);
          resolve();
        });
        frame.addEventListener("error", function onError() {
          frame.removeEventListener("error", onError);
          reject(new Error("games iframe failed to load"));
        });
        document.body.appendChild(frame);
      });

      await new Promise((resolve, reject) => {
        const start = performance.now();
        (function poll() {
          if (frame.contentWindow && typeof frame.contentWindow.__embeddedRelease === "function") {
            resolve();
            return;
          }
          if (performance.now() - start > READY_TIMEOUT_MS) {
            reject(new Error("games iframe script did not expose __embeddedRelease in time"));
            return;
          }
          window.setTimeout(poll, READY_POLL_MS);
        })();
      });
    })();
    return gamesFrameReadyPromise;
  }

  // Returns the frame only if it is fully ready to be revealed right now —
  // the single check beginInstrumentation() uses to decide seamless-reveal
  // vs. the original real-navigation fallback.
  function getReadyGamesFrame() {
    const frame = document.getElementById(GAMES_IFRAME_ID);
    if (!frame || !frame.contentWindow) return null;
    if (typeof frame.contentWindow.__embeddedRelease !== "function") return null;
    return frame;
  }

  // Back-button / history restoration for the seamless path. Only acts if
  // the games iframe is actually the visible surface right now — a
  // no-op on the very first pageload's own initial (non-pushed) history
  // entry, and a no-op if the visitor never seamlessly crossed at all
  // (e.g. the marker/location.assign() fallback ran instead, in which
  // case Back is ordinary cross-document back-navigation, unaffected by
  // anything in this file).
  window.addEventListener("popstate", () => {
    const frame = document.getElementById(GAMES_IFRAME_ID);
    if (!frame || !frame.classList.contains("is-visible")) return;
    frame.classList.remove("is-visible");
    frame.inert = true;
    if (window.__mvExperiment && typeof window.__mvExperiment.resumeRenderLoop === "function") {
      window.__mvExperiment.resumeRenderLoop();
    }
    // Same, already-proven technique the bfcache/pageshow handler below
    // uses: never call the frozen engine's reset() directly, only ever
    // via the real #mv-reset button's own click listener.
    const resetBtn = document.getElementById("mv-reset");
    if (resetBtn && !resetBtn.disabled) resetBtn.click();
    handedOff = false;
    bootstrapping = false;
    // Genuinely back at rest in "solid" phase — safe (and correct, for a
    // second click in the same page session) to resume keeping the Home
    // texture live again. liveCaptureDisarmed only needs to stay set
    // between the moment activation begins and the moment the visitor is
    // fully back at rest; re-arming here does not reopen the race
    // disarmLiveCaptureRefresher() fixed, since the next click still
    // disarms it again as its very first synchronous action.
    liveCaptureDisarmed = false;
    armLiveCaptureRefresher();
  });

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

        // seamless-crossing experiment addition — try the in-document
        // reveal first; fall through to the exact original mechanism
        // (unchanged, below) if the prewarmed iframe isn't ready.
        const readyFrame = getReadyGamesFrame();
        window.__a1Instrumentation.seamlessHandoffUsed = !!readyFrame;
        if (readyFrame) {
          // Release the iframe's OWN narrative reveal now — it runs the
          // identical double-rAF anchor-then-paint guarantee
          // game-localization/script.js already uses for the real-
          // navigation path (see its isHandoffEntry branch), just
          // triggered externally instead of automatically on load. This
          // happens first, and off-screen (still opacity 0), so its own
          // reveal transition is never visible — by the time we reveal
          // the iframe below, it has already been sitting in its fully
          // pre-reveal-correct anchor state for at least two of its own
          // frames.
          readyFrame.contentWindow.__embeddedRelease();

          // Same two-rAF idiom as the original exit path (and the
          // Boundary-B fix): the first rAF's callback does nothing but
          // schedule the second, guaranteeing the canvas's current
          // (Arrival-stable) frame gets a genuine, distinct paint of its
          // own before the swap mutation below runs on the nested rAF.
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              window.__a1Instrumentation.navigateInitiatedAt = Math.round(performance.now() - activatedAt);
              log("revealing prewarmed Games surface (no document navigation)", { href: link.href });

              readyFrame.inert = false;
              readyFrame.removeAttribute("aria-hidden");
              readyFrame.classList.add("is-visible");
              try {
                if (readyFrame.contentDocument && readyFrame.contentDocument.title) {
                  document.title = readyFrame.contentDocument.title;
                }
              } catch { /* cross-origin or not-yet-available — title stays as-is */ }
              try {
                window.history.pushState({ a1SeamlessGames: true }, "", link.href);
              } catch (error) {
                log("history.pushState failed (non-fatal — URL will not reflect the games page)", error && error.message ? error.message : String(error));
              }

              // Resource hygiene only, deferred well past the swap so it
              // can never race or visually couple with it: the canvas is
              // already fully occluded by the now-visible iframe (higher
              // z-index) by the time this runs. Stops the Home WebGL
              // render loop, which would otherwise keep running
              // indefinitely in the background now that Home's own
              // document is never actually torn down.
              window.setTimeout(() => {
                const canvasEl = document.getElementById("mv-canvas");
                if (canvasEl) canvasEl.classList.remove("is-visible", "mv-canvas--interactive");
                if (window.__mvExperiment && typeof window.__mvExperiment.pauseRenderLoop === "function") {
                  window.__mvExperiment.pauseRenderLoop();
                }
              }, 400);
            });
          });
          return;
        }

        // Original A4 mechanism — unchanged, always available as a
        // fallback (prewarmed iframe never became ready: e.g. a very fast
        // activation, a slow network, or an html2canvas/iframe failure).
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
          const engineReady = ensureEngineReady().catch((error) => {
            // Swallow here — this is a best-effort prewarm. Any real
            // failure surfaces identically through the click handler's
            // own ensureEngineReady() call and its existing
            // fallbackNavigate() path.
            log("prewarm failed (non-fatal, click path will retry)", error && error.message ? error.message : String(error));
          });
          // seamless-crossing experiment additions — same trigger as the
          // engine prewarm above, but deliberately SEQUENCED after it
          // genuinely finishes (not just started) rather than fired in
          // parallel or merely deferred a tick. WebGL context creation
          // (inside ensureEngineReady() -> initialize(), frozen) is the
          // one truly critical, latency-sensitive resource being
          // prewarmed here. Empirically, in this sandbox's software-GL
          // (SwiftShader) path, any of the games iframe's own document
          // load/script execution, or html2canvas's DOM rasterization,
          // overlapping with WebGL context creation measurably increases
          // context-creation failures — plain parallel dispatch, and even
          // a same-tick requestIdleCallback deferral (which can still
          // overlap a slow initialize() that hasn't resolved yet), both
          // reproduced it. Waiting for engineReady to actually settle
          // before starting either one removes the overlap entirely, and
          // running the iframe load and the first live capture in
          // sequence (not both at once) spreads out the remaining CPU
          // cost further. Total added lead time versus firing everything
          // at once is at most a second or two — irrelevant against the
          // many seconds a visitor typically dwells on Expertise before
          // clicking. Neither failure path here touches bootstrap()/the
          // click handler at all; beginInstrumentation() simply falls
          // back to the original mechanism if either isn't ready when
          // needed.
          engineReady.then(() => ensureGamesFrameReady()).catch((error) => {
            log("games iframe prewarm failed (non-fatal — real navigation fallback remains available)", error && error.message ? error.message : String(error));
          }).then(() => {
            armLiveCaptureRefresher();
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
    // Must be the first synchronous action, before any await and before
    // activateBtn.click() below triggers activate()'s scroll-lock reflow —
    // see disarmLiveCaptureRefresher()'s own comment for why.
    disarmLiveCaptureRefresher();
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
