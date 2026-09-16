// experiment/river-crossing-openai-v3
// Click-origin material front. The approved material-engine.js remains
// untouched. The live Home stays visually authoritative while a feathered
// WebGL material front grows from the visitor's actual click/touch point.
(() => {
  "use strict";

  const ENTRY_SELECTOR = 'a.expertise__link[href="game-localization/"]';
  const PREWARM_TRIGGER_SELECTOR = "#expertise";
  const BASE = "threshold-integration/";
  const READY_TIMEOUT_MS = 8000;
  const READY_POLL_MS = 40;
  const MATERIAL_FRONT_DURATION_MS = 1650;
  const MATERIAL_FRONT_FEATHER_PX = 82;

  const HANDOFF_STORAGE_KEY = "phase1dThresholdHandoff";
  const HANDOFF_MARKER_VERSION = 1;
  const HANDOFF_MARKER_SOURCE = "threshold-integration-phase1d";

  const HOME_REFERENCE = {
    desktop: { cssWidth: 1366, cssHeight: 800 },
    mobile: { cssWidth: 390, cssHeight: 844 }
  };

  let bootstrapping = false;
  let handedOff = false;
  let engineReadyPromise = null;
  let releaseInput = null;
  let frontFrame = 0;

  const root = document.documentElement;

  function log(label, detail) {
    console.info(`[river-v3] ${label}`, detail === undefined ? "" : detail);
  }

  window.__riverInstrumentation = {
    clickedAt: null,
    clickOrigin: null,
    prewarmStartedAt: null,
    prewarmReadyAt: null,
    activatedAt: null,
    frontStartedAt: null,
    frontCompletedAt: null,
    domRetiredAt: null,
    arrivalStableAt: null,
    navigateInitiatedAt: null,
    events: [],
    fallback: null
  };

  function isStandardActivation(event, link) {
    if (
      event.defaultPrevented || event.button !== 0 || event.metaKey ||
      event.ctrlKey || event.shiftKey || event.altKey ||
      link.target === "_blank" || link.hasAttribute("download")
    ) return false;
    try {
      return new URL(link.href, location.href).origin === location.origin;
    } catch { return false; }
  }

  function originFromEvent(event, link) {
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX || event.clientY)) {
      return { x: event.clientX, y: event.clientY };
    }
    const r = link.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function ensureStylesheet() {
    if (document.getElementById("river-harness-css")) return;
    const link = document.createElement("link");
    link.id = "river-harness-css";
    link.rel = "stylesheet";
    link.href = `${BASE}river-harness.css`;
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

    for (const id of ["mv-activate", "mv-reset"]) {
      const button = document.createElement("button");
      button.id = id;
      button.type = "button";
      button.disabled = true;
      button.tabIndex = -1;
      controls.appendChild(button);
    }

    const status = document.createElement("span");
    status.id = "mv-status";
    status.dataset.state = "idle";
    status.textContent = "idle";
    controls.appendChild(status);
    document.body.appendChild(controls);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`failed to load ${src}`));
      img.src = src;
    });
  }

  async function loadHomeOverride() {
    const [desktop, mobile] = await Promise.all([
      loadImage(`${BASE}prebaked/mv-home-desktop.png`),
      loadImage(`${BASE}prebaked/mv-home-iphone.png`)
    ]);
    return { desktop, mobile };
  }

  async function loadGamesOverride() {
    const [desktop, mobile] = await Promise.all([
      loadImage(`${BASE}prebaked/river-games-desktop.svg`),
      loadImage(`${BASE}prebaked/river-games-iphone.svg`)
    ]);
    return { desktop, mobile };
  }

  function applyOverrides(homeImages, gamesImages) {
    window.__threshold_homeOverride = homeImages;
    window.__threshold_gamesOverride = gamesImages;
    window.__MV_MANIFEST_INLINE__ = {
      desktop: { file: "prebaked/mv-home-desktop.png", cssWidth: HOME_REFERENCE.desktop.cssWidth, cssHeight: HOME_REFERENCE.desktop.cssHeight },
      mobile: { file: "prebaked/mv-home-iphone.png", cssWidth: HOME_REFERENCE.mobile.cssWidth, cssHeight: HOME_REFERENCE.mobile.cssHeight }
    };
  }

  function loadEngineScript() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = "river-material-engine";
      script.src = `${BASE}material-engine.js`;
      script.onload = resolve;
      script.onerror = () => reject(new Error("material-engine.js failed to load"));
      document.body.appendChild(script);
    });
  }

  function waitForEngineReady() {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      let settled = false;
      function poll() {
        if (settled) return;
        const activate = document.getElementById("mv-activate");
        const status = document.getElementById("mv-status");
        if (status && status.dataset.state === "fallback") {
          settled = true;
          reject(new Error(`engine fallback: ${status.textContent}`));
          return;
        }
        if (activate && !activate.disabled && window.__mvCrossing) {
          settled = true;
          resolve();
          return;
        }
        if (performance.now() - started > READY_TIMEOUT_MS) {
          settled = true;
          reject(new Error("engine readiness timeout"));
          return;
        }
        setTimeout(poll, READY_POLL_MS);
      }
      poll();
    });
  }

  function ensureEngineReady() {
    if (engineReadyPromise) return engineReadyPromise;
    window.__riverInstrumentation.prewarmStartedAt = Math.round(performance.now());
    engineReadyPromise = (async () => {
      ensureStylesheet();
      ensureMarkup();
      const [home, games] = await Promise.all([loadHomeOverride(), loadGamesOverride()]);
      applyOverrides(home, games);
      if (!window.__mvCrossing) await loadEngineScript();
      await waitForEngineReady();
      window.__riverInstrumentation.prewarmReadyAt = Math.round(performance.now());
    })();
    return engineReadyPromise;
  }

  function armPrewarm() {
    const link = document.querySelector(ENTRY_SELECTOR);
    const target = document.querySelector(PREWARM_TRIGGER_SELECTOR);
    const warm = () => ensureEngineReady().catch((e) => log("prewarm failed", e.message));

    if (link) {
      link.addEventListener("pointerenter", warm, { once: true, passive: true });
      link.addEventListener("focus", warm, { once: true, passive: true });
      link.addEventListener("touchstart", warm, { once: true, passive: true });
    }
    if (target && "IntersectionObserver" in window) {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          warm();
        }
      }, { rootMargin: "120% 0px", threshold: 0 });
      observer.observe(target);
    } else if ("requestIdleCallback" in window) {
      requestIdleCallback(warm, { timeout: 1800 });
    } else {
      setTimeout(warm, 900);
    }
  }

  function freezeInput() {
    if (releaseInput) return;
    const prevent = (event) => event.preventDefault();
    const preventKeys = (event) => {
      if (["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"," "].includes(event.key)) event.preventDefault();
    };
    window.addEventListener("wheel", prevent, { passive: false, capture: true });
    window.addEventListener("touchmove", prevent, { passive: false, capture: true });
    window.addEventListener("keydown", preventKeys, { capture: true });
    releaseInput = () => {
      window.removeEventListener("wheel", prevent, true);
      window.removeEventListener("touchmove", prevent, true);
      window.removeEventListener("keydown", preventKeys, true);
      releaseInput = null;
    };
  }

  function prefetchGames(link) {
    if (document.getElementById("river-games-prefetch")) return;
    const hint = document.createElement("link");
    hint.id = "river-games-prefetch";
    hint.rel = "prefetch";
    hint.href = link.href;
    document.head.appendChild(hint);
  }

  function writeHandoffMarker() {
    try {
      sessionStorage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify({
        version: HANDOFF_MARKER_VERSION,
        source: HANDOFF_MARKER_SOURCE,
        stableAt: Date.now()
      }));
      return true;
    } catch { return false; }
  }

  function recordState(activatedAt, label) {
    const c = window.__mvCrossing;
    const entry = {
      label,
      tMs: Math.round(performance.now() - activatedAt),
      phase: c?.getPhase?.() ?? null,
      revealSubStage: c?.getRevealSubStage?.() ?? null,
      arrivalPhase: c?.getArrivalPhase?.() ?? null
    };
    window.__riverInstrumentation.events.push(entry);
    log(label, entry);
  }

  function monitor(activatedAt, link) {
    let phase, subStage, arrival;
    let navigating = false;
    prefetchGames(link);
    function tick() {
      const c = window.__mvCrossing;
      if (!c) { requestAnimationFrame(tick); return; }
      const p = c.getPhase?.();
      const s = c.getRevealSubStage?.();
      const a = c.getArrivalPhase?.();
      if (p !== phase) { phase = p; recordState(activatedAt, `phase:${p}`); }
      if (s !== subStage) { subStage = s; recordState(activatedAt, `stage:${s}`); }
      if (a !== arrival) { arrival = a; recordState(activatedAt, `arrival:${a}`); }
      if (!navigating && a === "stable") {
        navigating = true;
        window.__riverInstrumentation.arrivalStableAt = Math.round(performance.now() - activatedAt);
        writeHandoffMarker();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__riverInstrumentation.navigateInitiatedAt = Math.round(performance.now() - activatedAt);
          location.assign(link.href);
        }));
        return;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function easeMaterialFront(t) {
    // Smoothstep: the front is born gently at the touch point, gains momentum
    // through the middle, then settles as it reaches the farthest corner.
    return t * t * (3 - 2 * t);
  }

  function setFrontRadius(radius) {
    const inner = Math.max(0, radius - MATERIAL_FRONT_FEATHER_PX);
    root.style.setProperty("--river-radius", `${radius.toFixed(1)}px`);
    root.style.setProperty("--river-inner-radius", `${inner.toFixed(1)}px`);
  }

  function startMaterialFront(activatedAt, origin) {
    cancelAnimationFrame(frontFrame);
    const x = Math.min(Math.max(origin.x, 0), innerWidth);
    const y = Math.min(Math.max(origin.y, 0), innerHeight);
    const farX = Math.max(x, innerWidth - x);
    const farY = Math.max(y, innerHeight - y);
    const maxRadius = Math.hypot(farX, farY) + MATERIAL_FRONT_FEATHER_PX + 24;

    root.style.setProperty("--river-origin-x", `${x.toFixed(1)}px`);
    root.style.setProperty("--river-origin-y", `${y.toFixed(1)}px`);
    setFrontRadius(0);
    root.classList.add("river-transitioning", "river-material-front");
    window.__riverInstrumentation.frontStartedAt = Math.round(performance.now() - activatedAt);

    const start = performance.now();
    function frame(now) {
      const raw = Math.min(1, Math.max(0, (now - start) / MATERIAL_FRONT_DURATION_MS));
      const eased = easeMaterialFront(raw);
      setFrontRadius(maxRadius * eased);
      if (raw < 1) {
        frontFrame = requestAnimationFrame(frame);
        return;
      }
      root.classList.add("river-dom-retired");
      root.classList.remove("river-material-front");
      root.style.removeProperty("--river-radius");
      root.style.removeProperty("--river-inner-radius");
      window.__riverInstrumentation.frontCompletedAt = Math.round(performance.now() - activatedAt);
      window.__riverInstrumentation.domRetiredAt = window.__riverInstrumentation.frontCompletedAt;
    }
    frontFrame = requestAnimationFrame(frame);
  }

  function triggerOriginImpulse(origin) {
    const canvas = document.getElementById("mv-canvas");
    if (!canvas) return;
    // The preserved engine already maps canvas clicks into its recovered
    // Gaussian water impulse. Re-dispatching the visitor's exact coordinates
    // makes the physical disturbance and the visible reveal share one origin.
    canvas.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: origin.x,
      clientY: origin.y
    }));
  }

  async function bootstrap(link, origin) {
    if (bootstrapping || handedOff) return;
    bootstrapping = true;
    freezeInput();
    try {
      await ensureEngineReady();
      handedOff = true;
      const activatedAt = performance.now();
      window.__riverInstrumentation.activatedAt = activatedAt;
      window.__riverInstrumentation.clickOrigin = { x: Math.round(origin.x), y: Math.round(origin.y) };

      startMaterialFront(activatedAt, origin);
      document.getElementById("mv-activate").click();
      requestAnimationFrame(() => triggerOriginImpulse(origin));
      monitor(activatedAt, link);
    } catch (error) {
      window.__riverInstrumentation.fallback = error.message;
      releaseInput?.();
      location.assign(link.href);
    } finally {
      bootstrapping = false;
    }
  }

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest(ENTRY_SELECTOR);
    if (!(link instanceof HTMLAnchorElement) || !isStandardActivation(event, link)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.__riverInstrumentation.clickedAt = performance.now();
    bootstrap(link, originFromEvent(event, link));
  }, true);

  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    bootstrapping = false;
    handedOff = false;
    cancelAnimationFrame(frontFrame);
    releaseInput?.();
    root.classList.remove("river-transitioning", "river-material-front", "river-dom-retired");
    ["--river-origin-x","--river-origin-y","--river-radius","--river-inner-radius"].forEach((p) => root.style.removeProperty(p));
    const reset = document.getElementById("mv-reset");
    const crossing = window.__mvCrossing;
    if (crossing?.getPhase?.() !== "solid" && reset && !reset.disabled) reset.click();
  });

  armPrewarm();
})();