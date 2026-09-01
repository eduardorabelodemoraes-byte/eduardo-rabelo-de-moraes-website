(() => {
  "use strict";

  const STORAGE_KEY = "gameLocalizationEntry";
  const CURRENT_MARKER_VERSION = 2;
  const LEGACY_MARKER_VERSION = 1;
  const MAX_MARKER_AGE = 10000;
  const BLACK_HOLD = Object.freeze({
    full: 750,
    lightweight: 600,
    reduced: 300,
    essential: 300,
    direct: 800
  });
  const root = document.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function normalizeMode(marker) {
    if (marker.version === CURRENT_MARKER_VERSION) {
      return ["full", "lightweight", "reduced", "essential"].includes(marker.mode)
        ? marker.mode
        : null;
    }

    if (marker.version === LEGACY_MARKER_VERSION) {
      return marker.motion === "reduced" ? "reduced" : "full";
    }

    return null;
  }

  function readEntryMarker() {
    try {
      const rawMarker = window.sessionStorage.getItem(STORAGE_KEY);

      if (!rawMarker) {
        return null;
      }

      window.sessionStorage.removeItem(STORAGE_KEY);
      const marker = JSON.parse(rawMarker);
      const markerAge = Date.now() - marker.blackAt;
      const mode = normalizeMode(marker);

      if (
        marker.source !== "home" ||
        !Number.isFinite(marker.blackAt) ||
        markerAge < 0 ||
        markerAge > MAX_MARKER_AGE ||
        !mode
      ) {
        return null;
      }

      return { blackAt: marker.blackAt, mode };
    } catch {
      return null;
    }
  }

  function beginPrologue() {
    const marker = readEntryMarker();
    const entryMode = reduceMotion ? "reduced" : marker?.mode;
    const requiredHold = entryMode
      ? BLACK_HOLD[entryMode]
      : BLACK_HOLD.direct;
    const elapsedBlack = marker ? Date.now() - marker.blackAt : 0;
    const remainingHold = Math.max(0, requiredHold - elapsedBlack);

    window.setTimeout(() => {
      root.classList.add("experience-started");
    }, remainingHold);
  }

  function configureExit() {
    const exit = document.querySelector("[data-experience-exit]");

    if (!exit) {
      return;
    }

    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      exit.classList.add("is-revealed");
      exit.focus({ preventScroll: true });
    });
  }

  root.classList.add("experience-initialized");
  beginPrologue();
  configureExit();
})();
