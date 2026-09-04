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

  // Integration Candidate A1 (reusing the Phase 1D marker design verified
  // earlier in this repository's own history). Entirely separate from
  // STORAGE_KEY above — this marker means "the visitor already watched the
  // full approved Crossing + Arrival on Home and is looking at a stable
  // Games frame that should match this page's own settled state", the
  // opposite of the legacy marker's black-hold-to-match semantics.
  const HANDOFF_STORAGE_KEY = "phase1dThresholdHandoff";
  const HANDOFF_MARKER_VERSION = 1;
  const HANDOFF_MARKER_SOURCE = "threshold-integration-phase1d";
  const MAX_HANDOFF_MARKER_AGE = 10000;

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

  // Integration Candidate A1: reads and consumes (one-shot) the
  // Threshold-completed handoff marker. Returns the parsed marker only if
  // present, well-formed, correctly versioned/sourced, and fresh;
  // otherwise null, in which case the caller falls through to the
  // pre-existing beginPrologue() path exactly as it already behaves for
  // ordinary Home entry, direct navigation, and refresh.
  function readHandoffMarker() {
    try {
      const rawMarker = window.sessionStorage.getItem(HANDOFF_STORAGE_KEY);
      if (!rawMarker) {
        return null;
      }
      window.sessionStorage.removeItem(HANDOFF_STORAGE_KEY);
      const marker = JSON.parse(rawMarker);
      const markerAge = Date.now() - marker.stableAt;
      if (
        marker.version !== HANDOFF_MARKER_VERSION ||
        marker.source !== HANDOFF_MARKER_SOURCE ||
        !Number.isFinite(marker.stableAt) ||
        markerAge < 0 ||
        markerAge > MAX_HANDOFF_MARKER_AGE
      ) {
        return null;
      }
      return marker;
    } catch {
      return null;
    }
  }

  // Integration Candidate A1: reveals the page's already-settled editorial
  // state immediately and without animation, reusing the CSS this document
  // already ships for its own failsafe path — no new class, no styles.css
  // or index.html change needed.
  function beginThresholdHandoffReveal() {
    root.classList.add("experience-started");
    root.classList.add("experience-failsafe");
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

  // Integration Candidate A1: a valid Threshold-completed marker takes an
  // entirely separate reveal path (instant, no black hold, no animation).
  // Its absence falls through to the pre-existing, byte-unmodified
  // beginPrologue() below exactly as before.
  const handoffMarker = readHandoffMarker();
  if (handoffMarker) {
    beginThresholdHandoffReveal();
  } else {
    beginPrologue();
  }

  configureExit();
})();
