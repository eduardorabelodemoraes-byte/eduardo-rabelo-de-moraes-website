(() => {
  "use strict";

  const ENTRY_SELECTOR = "[data-game-localization-entry]";
  const STORAGE_KEY = "gameLocalizationEntry";
  const root = document.documentElement;
  let activeTransition = null;

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

    const destination = new URL(link.href, window.location.href);
    return destination.origin === window.location.origin;
  }

  function getOrigin(event, link) {
    if (event.detail !== 0 && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      return { x: event.clientX, y: event.clientY };
    }

    const bounds = link.getBoundingClientRect();
    return {
      x: bounds.left + (bounds.width / 2),
      y: bounds.top + (bounds.height / 2)
    };
  }

  function createTransition(origin, reducedMotion) {
    const transition = document.createElement("div");
    transition.className = "game-transition";
    transition.setAttribute("aria-hidden", "true");
    transition.style.setProperty("--game-transition-x", `${origin.x}px`);
    transition.style.setProperty("--game-transition-y", `${origin.y}px`);
    transition.style.setProperty(
      "--game-transition-duration",
      reducedMotion ? "560ms" : "2100ms"
    );
    transition.innerHTML = [
      '<span class="game-transition__membrane"></span>',
      '<span class="game-transition__wash"></span>',
      '<span class="game-transition__black"></span>'
    ].join("");
    document.body.append(transition);
    return transition;
  }

  function storeEntryMarker(reducedMotion) {
    const marker = {
      version: 1,
      source: "home",
      blackAt: Date.now(),
      motion: reducedMotion ? "reduced" : "standard"
    };

    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(marker));
    } catch {
      // The destination treats a missing marker as a normal direct entry.
    }
  }

  function resetTransition() {
    if (activeTransition?.timeouts) {
      activeTransition.timeouts.forEach(window.clearTimeout);
    }

    if (activeTransition?.escapeHandler) {
      window.removeEventListener("keydown", activeTransition.escapeHandler, true);
    }

    activeTransition?.element?.remove();
    activeTransition = null;
    root.classList.remove(
      "game-transition-running",
      "game-transition-crossing",
      "game-transition-black",
      "game-transition-reduced"
    );
    root.style.removeProperty("--game-transition-duration");
  }

  function startTransition(event, link) {
    if (activeTransition || !isStandardActivation(event, link)) {
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timing = reducedMotion
      ? { pause: 40, crossing: 560, settle: 60, safety: 1400 }
      : { pause: 220, crossing: 2100, settle: 120, safety: 3800 };
    const origin = getOrigin(event, link);
    const transition = createTransition(origin, reducedMotion);
    const destination = link.href;
    let navigationStarted = false;
    let markerStored = false;

    function establishBlack() {
      root.classList.add("game-transition-black");
      transition.classList.add("is-black");

      if (!markerStored) {
        markerStored = true;
        storeEntryMarker(reducedMotion);
      }
    }

    function navigate() {
      if (navigationStarted) {
        return;
      }

      navigationStarted = true;
      establishBlack();
      window.location.assign(destination);
    }

    function escapeHandler(escapeEvent) {
      if (escapeEvent.key !== "Escape") {
        return;
      }

      escapeEvent.preventDefault();
      establishBlack();
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(navigate);
      });
    }

    event.preventDefault();
    activeTransition = {
      element: transition,
      escapeHandler,
      timeouts: []
    };

    root.style.setProperty(
      "--game-transition-duration",
      reducedMotion ? "560ms" : "2100ms"
    );
    root.classList.add("game-transition-running");

    if (reducedMotion) {
      root.classList.add("game-transition-reduced");
      transition.classList.add("game-transition--reduced");
    }

    window.addEventListener("keydown", escapeHandler, true);

    activeTransition.timeouts.push(
      window.setTimeout(() => {
        root.classList.add("game-transition-crossing");
        transition.classList.add("is-crossing");
      }, timing.pause),
      window.setTimeout(establishBlack, timing.pause + timing.crossing),
      window.setTimeout(navigate, timing.pause + timing.crossing + timing.settle),
      window.setTimeout(navigate, timing.safety)
    );
  }

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    const link = event.target.closest(ENTRY_SELECTOR);
    if (link instanceof HTMLAnchorElement) {
      startTransition(event, link);
    }
  });

  window.addEventListener("pageshow", resetTransition);
})();
