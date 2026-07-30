(() => {
  "use strict";

  const STORAGE_KEY = "gameLocalizationEntry";
  const MAX_MARKER_AGE = 10000;
  const DEFAULT_BLACK_HOLD = 800;
  const REDUCED_BLACK_HOLD = 300;
  const root = document.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function readEntryMarker() {
    try {
      const rawMarker = window.sessionStorage.getItem(STORAGE_KEY);

      if (!rawMarker) {
        return null;
      }

      window.sessionStorage.removeItem(STORAGE_KEY);
      const marker = JSON.parse(rawMarker);
      const markerAge = Date.now() - marker.blackAt;

      if (
        marker.version !== 1 ||
        marker.source !== "home" ||
        !Number.isFinite(marker.blackAt) ||
        markerAge < 0 ||
        markerAge > MAX_MARKER_AGE
      ) {
        return null;
      }

      return marker;
    } catch {
      return null;
    }
  }

  function beginPrologue() {
    const marker = readEntryMarker();
    const reducedEntry = reduceMotion || marker?.motion === "reduced";
    const requiredHold = reducedEntry ? REDUCED_BLACK_HOLD : DEFAULT_BLACK_HOLD;
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

  beginPrologue();
  configureExit();
})();
