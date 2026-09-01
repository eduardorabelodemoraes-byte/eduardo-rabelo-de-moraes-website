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

  // Phase 1D: Threshold-completed handoff marker. Entirely separate from
  // STORAGE_KEY above (see threshold-integration/phase1c-integration.js for
  // why a new key was used rather than extending the legacy one). This
  // marker means "the visitor already watched the full frozen Crossing +
  // Arrival sequence on Home and is looking at a stable Games frame that is
  // pixel-equivalent to this page's own settled state" — the opposite of
  // the legacy marker's black-hold-to-match semantics.
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

  // Phase 1D: reads and consumes (one-shot) the Threshold-completed handoff
  // marker. Returns the parsed marker only if it is present, well-formed,
  // correctly versioned/sourced, and fresh; otherwise null, in which case
  // the caller falls through to the pre-existing beginPrologue() path
  // exactly as it already behaves for legacy Home and direct/refresh entry.
  function readHandoffMarker() {
    try {
      const rawMarker = window.sessionStorage.getItem(HANDOFF_STORAGE_KEY);

      if (!rawMarker) {
        return null;
      }

      // One-shot: removed immediately on read, regardless of validity, so
      // a stale or malformed marker can never be reused by a later
      // refresh or direct revisit within the same session.
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

  // Phase 1D: the target-side half of the handoff. Reveals the page's
  // already-settled editorial state immediately and without animation by
  // reusing the CSS this document already ships for its own failsafe path
  // (index.html: ".js.experience-failsafe.experience-started { animation:
  // none; opacity: 1; }") — no new class, no new CSS rule, no styles.css or
  // game-localization/index.html change was needed to produce an instant,
  // fully-composed reveal. This intentionally repurposes an existing
  // "skip the animation" mechanism for an unrelated trigger (a completed
  // Threshold handoff rather than a script failure); both triggers want
  // the exact same visual outcome, so no new CSS path was justified under
  // the "avoid modifying styles.css/index.html unless necessary" scope
  // limit.
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

  // Phase 1D: a valid Threshold-completed marker takes an entirely separate
  // reveal path (instant, no black hold, no animation). Its absence —
  // including on ordinary refresh/direct navigation to this page, and on
  // the existing ungated Home entry — falls through to the pre-existing,
  // byte-unmodified beginPrologue() below exactly as before.
  const handoffMarker = readHandoffMarker();
  if (handoffMarker) {
    beginThresholdHandoffReveal();
  } else {
    beginPrologue();
  }

  configureExit();
})();
