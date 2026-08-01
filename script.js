(() => {
  "use strict";

  const ENTRY_SELECTOR = "[data-game-localization-entry]";
  const STORAGE_KEY = "gameLocalizationEntry";
  const MARKER_VERSION = 2;
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const LANGUAGE_SELECTOR = "h1, h2, h3, h4, h5, h6, p, a, li, summary, address, blockquote";
  const SCROLL_KEYS = new Set([
    " ",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "End",
    "Home",
    "PageDown",
    "PageUp"
  ]);
  const root = document.documentElement;

  const MODE_CONFIG = Object.freeze({
    full: {
      timeline: [120, 350, 900, 1200, 1450, 1650],
      primaryDisplacement: 10,
      secondaryDisplacement: 5,
      languageDisplacement: 1.5,
      effectiveDensity: 1.75,
      pixelBudget: 6500000,
      safetyDelay: 3600
    },
    lightweight: {
      timeline: [100, 300, 760, 1000, 1220, 1400],
      primaryDisplacement: 5,
      secondaryDisplacement: 0,
      languageDisplacement: 0.8,
      effectiveDensity: 1.5,
      pixelBudget: 3500000,
      safetyDelay: 3100
    },
    reduced: {
      timeline: [90, 210, 390, 520, 640, 760],
      primaryDisplacement: 1.4,
      secondaryDisplacement: 0,
      languageDisplacement: 0.35,
      effectiveDensity: 1.25,
      pixelBudget: 2000000,
      safetyDelay: 2200
    }
  });

  let activeTransition = null;
  let resourceSequence = 0;
  const pointerOrigins = new WeakMap();

  function clamp(value, minimum = 0, maximum = 1) {
    return Math.min(maximum, Math.max(minimum, value));
  }
  function lerp(start, end, progress) {
    return start + ((end - start) * progress);
  }

  function easeOutCubic(progress) {
    return 1 - Math.pow(1 - clamp(progress), 3);
  }

  function smoothstep(progress) {
    const value = clamp(progress);
    return value * value * (3 - (2 * value));
  }

  function segmentProgress(elapsed, start, end) {
    if (end <= start) {
      return 1;
    }

    return clamp((elapsed - start) / (end - start));
  }

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

  function getLinkCenter(link) {
    const bounds = link.getBoundingClientRect();
    return {
      x: bounds.left + (bounds.width / 2),
      y: bounds.top + (bounds.height / 2)
    };
  }

  function getOrigin(event, link) {
    if (event.detail === 0) {
      return getLinkCenter(link);
    }

    const pointerOrigin = pointerOrigins.get(link);
    if (pointerOrigin && performance.now() - pointerOrigin.timestamp < 1200) {
      return { x: pointerOrigin.x, y: pointerOrigin.y };
    }

    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      return { x: event.clientX, y: event.clientY };
    }

    return getLinkCenter(link);
  }

  function detectCapabilities() {
    const cssSupports = typeof window.CSS?.supports === "function";
    const supportsFilter = cssSupports && window.CSS.supports("filter", "url(#threshold-filter)");
    const supportsMask = cssSupports && (
      window.CSS.supports("mask-image", "linear-gradient(#000, #000)") ||
      window.CSS.supports("-webkit-mask-image", "linear-gradient(#000, #000)")
    );
    const supportsSvg = typeof document.createElementNS === "function";
    const supportsAnimationFrame = typeof window.requestAnimationFrame === "function";

    return {
      supportsAdvancedOptics: supportsFilter && supportsSvg && supportsAnimationFrame,
      supportsMask
    };
  }

  function selectExecutionMode() {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const capabilities = detectCapabilities();

    if (!capabilities.supportsAdvancedOptics) {
      return { name: "essential", capabilities };
    }

    if (reduceMotion) {
      return { name: "reduced", capabilities };
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const effectiveDensity = Math.min(devicePixelRatio, MODE_CONFIG.full.effectiveDensity);
    const effectivePixels = viewportWidth * viewportHeight * Math.pow(effectiveDensity, 2);
    const deviceMemory = Number(navigator.deviceMemory);
    const hardwareConcurrency = Number(navigator.hardwareConcurrency);
    const memoryAllowsFull = Number.isFinite(deviceMemory)
      ? deviceMemory >= 4
      : viewportWidth >= 1024;
    const concurrencyAllowsFull = Number.isFinite(hardwareConcurrency)
      ? hardwareConcurrency >= 4
      : viewportWidth >= 1024;
    const fullModeIsStable = (
      capabilities.supportsMask &&
      viewportWidth >= 768 &&
      viewportHeight >= 520 &&
      effectivePixels <= 6500000 &&
      memoryAllowsFull &&
      concurrencyAllowsFull
    );

    return {
      name: fullModeIsStable ? "full" : "lightweight",
      capabilities
    };
  }

  function elementIntersectsViewport(element) {
    const bounds = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);

    return (
      bounds.width > 0 &&
      bounds.height > 0 &&
      bounds.bottom > 0 &&
      bounds.right > 0 &&
      bounds.top < window.innerHeight &&
      bounds.left < window.innerWidth &&
      styles.display !== "none" &&
      styles.visibility !== "hidden"
    );
  }

  function collectVisibleSources() {
    const sources = [];

    Array.from(document.body.children).forEach((element) => {
      if (!(element instanceof HTMLElement) || element.matches(".threshold-system")) {
        return;
      }

      if (element.tagName === "MAIN") {
        Array.from(element.children).forEach((section) => {
          if (section instanceof HTMLElement && elementIntersectsViewport(section)) {
            sources.push(section);
          }
        });
        return;
      }

      if (elementIntersectsViewport(element)) {
        sources.push(element);
      }
    });

    return sources;
  }

  function isLanguageElement(element) {
    return (
      element.matches(LANGUAGE_SELECTOR) &&
      element.textContent.trim().length > 0 &&
      elementIntersectsViewport(element)
    );
  }

  function findNearestLanguagePoint(sources, origin) {
    let nearestPoint = { ...origin };
    let nearestDistance = Number.POSITIVE_INFINITY;

    sources.forEach((source) => {
      const candidates = [];

      if (source.matches(LANGUAGE_SELECTOR)) {
        candidates.push(source);
      }

      source.querySelectorAll(LANGUAGE_SELECTOR).forEach((element) => candidates.push(element));

      candidates.forEach((element) => {
        if (!isLanguageElement(element)) {
          return;
        }

        const bounds = element.getBoundingClientRect();
        const point = {
          x: bounds.left + (bounds.width / 2),
          y: bounds.top + (bounds.height / 2)
        };
        const distance = Math.hypot(point.x - origin.x, point.y - origin.y);

        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestPoint = point;
        }
      });
    });

    return nearestPoint;
  }

  function removeActiveAttributes(element) {
    Array.from(element.attributes).forEach((attribute) => {
      if (
        attribute.name === "id" ||
        attribute.name === "name" ||
        attribute.name === "for" ||
        attribute.name === "form" ||
        attribute.name.startsWith("on") ||
        attribute.name === "aria-activedescendant" ||
        attribute.name === "aria-controls" ||
        attribute.name === "aria-describedby" ||
        attribute.name === "aria-details" ||
        attribute.name === "aria-errormessage" ||
        attribute.name === "aria-flowto" ||
        attribute.name === "aria-labelledby" ||
        attribute.name === "aria-owns"
      ) {
        element.removeAttribute(attribute.name);
      }
    });

    element.removeAttribute("contenteditable");
    element.removeAttribute("data-game-localization-entry");

    if (element.matches("a, area")) {
      element.removeAttribute("href");
      element.removeAttribute("target");
      element.removeAttribute("download");
    }

    if (element.matches("button, input, select, textarea")) {
      element.setAttribute("disabled", "");
    }

    if (element.matches("a, area, button, input, select, textarea, summary, [tabindex]")) {
      element.setAttribute("tabindex", "-1");
    }

    if (element.matches("audio, video, iframe, object, embed, source")) {
      element.removeAttribute("src");
      element.removeAttribute("srcset");
      element.removeAttribute("srcdoc");
      element.removeAttribute("data");
      element.removeAttribute("autoplay");
      element.removeAttribute("controls");
      element.setAttribute("aria-hidden", "true");
    }
  }

  function sanitizeClone(source, clone) {
    const sourceElements = [source, ...source.querySelectorAll("*")];
    const cloneElements = [clone, ...clone.querySelectorAll("*")];

    cloneElements.forEach((element, index) => {
      const sourceElement = sourceElements[index];
      removeActiveAttributes(element);

      if (sourceElement && isLanguageElement(sourceElement)) {
        element.setAttribute("data-threshold-language", "");
      }
    });
  }

  function createVisibleLayer(sources) {
    const layer = document.createElement("div");
    layer.className = "threshold-optical__layer threshold-optical__layer--base";

    sources.forEach((source) => {
      const bounds = source.getBoundingClientRect();
      const clipTop = Math.max(0, bounds.top);
      const clipRight = Math.min(window.innerWidth, bounds.right);
      const clipBottom = Math.min(window.innerHeight, bounds.bottom);
      const clipLeft = Math.max(0, bounds.left);
      const clipWidth = Math.max(0, clipRight - clipLeft);
      const clipHeight = Math.max(0, clipBottom - clipTop);

      if (clipWidth === 0 || clipHeight === 0) {
        return;
      }

      const fragment = document.createElement("div");
      fragment.className = "threshold-optical__fragment";
      fragment.style.top = `${clipTop}px`;
      fragment.style.left = `${clipLeft}px`;
      fragment.style.width = `${clipWidth}px`;
      fragment.style.height = `${clipHeight}px`;

      const clone = source.cloneNode(true);
      sanitizeClone(source, clone);
      clone.setAttribute("data-threshold-optical-clone", "");
      clone.style.setProperty("position", "absolute", "important");
      clone.style.setProperty("top", `${bounds.top - clipTop}px`, "important");
      clone.style.setProperty("left", `${bounds.left - clipLeft}px`, "important");
      clone.style.setProperty("width", `${bounds.width}px`, "important");
      clone.style.setProperty("height", `${bounds.height}px`, "important");
      clone.style.setProperty("margin", "0", "important");
      clone.style.setProperty("pointer-events", "none", "important");

      fragment.append(clone);
      layer.append(fragment);
    });

    return layer;
  }

  function createSvgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NAMESPACE, name);

    Object.entries(attributes).forEach(([attribute, value]) => {
      element.setAttribute(attribute, String(value));
    });

    return element;
  }

  function createDisplacementFilter(definitions, id, settings) {
    const filter = createSvgElement("filter", {
      id,
      x: "-6%",
      y: "-6%",
      width: "112%",
      height: "112%",
      "color-interpolation-filters": "sRGB",
      filterRes: `${settings.filterWidth} ${settings.filterHeight}`
    });
    const turbulence = createSvgElement("feTurbulence", {
      type: "fractalNoise",
      baseFrequency: settings.baseFrequency,
      numOctaves: "1",
      seed: settings.seed,
      result: "threshold-noise"
    });
    const displacement = createSvgElement("feDisplacementMap", {
      in: "SourceGraphic",
      in2: "threshold-noise",
      scale: "0",
      xChannelSelector: settings.xChannel,
      yChannelSelector: settings.yChannel
    });

    filter.append(turbulence, displacement);
    definitions.append(filter);
    return displacement;
  }

  function createOpticalSystem(sources, origin, modeSelection) {
    const mode = modeSelection.name;
    const configuration = MODE_CONFIG[mode];
    const sequence = ++resourceSequence;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const densityWithinBudget = Math.sqrt(
      configuration.pixelBudget / Math.max(1, viewportWidth * viewportHeight)
    );
    const effectiveDensity = Math.max(0.5, Math.min(
      Math.max(1, window.devicePixelRatio || 1),
      configuration.effectiveDensity,
      densityWithinBudget
    ));
    const filterWidth = Math.max(1, Math.round(viewportWidth * effectiveDensity));
    const filterHeight = Math.max(1, Math.round(viewportHeight * effectiveDensity));
    const primaryFilterId = `threshold-refraction-primary-${sequence}`;
    const secondaryFilterId = `threshold-refraction-secondary-${sequence}`;
    const languageFilterId = `threshold-refraction-language-${sequence}`;
    const system = document.createElement("div");
    const svg = createSvgElement("svg", {
      class: "threshold-system__svg",
      "aria-hidden": "true",
      focusable: "false"
    });
    const definitions = createSvgElement("defs");
    const primaryDisplacement = createDisplacementFilter(definitions, primaryFilterId, {
      filterWidth,
      filterHeight,
      baseFrequency: mode === "full" ? "0.008 0.015" : "0.011 0.018",
      seed: "11",
      xChannel: "R",
      yChannel: "B"
    });
    const languageDisplacement = createDisplacementFilter(definitions, languageFilterId, {
      filterWidth,
      filterHeight,
      baseFrequency: mode === "full" ? "0.01 0.013" : "0.014 0.016",
      seed: "31",
      xChannel: "B",
      yChannel: "G"
    });
    let secondaryDisplacement = null;

    if (mode === "full") {
      secondaryDisplacement = createDisplacementFilter(definitions, secondaryFilterId, {
        filterWidth,
        filterHeight,
        baseFrequency: "0.014 0.007",
        seed: "23",
        xChannel: "B",
        yChannel: "G"
      });
    }
    const optical = document.createElement("div");
    const baseLayer = createVisibleLayer(sources);
    const primaryLayer = baseLayer.cloneNode(true);
    const languageLayer = baseLayer.cloneNode(true);
    const blackGuard = document.createElement("div");
    const languagePoint = findNearestLanguagePoint(sources, origin);
    const fieldPoint = {
      x: clamp((languagePoint.x * 0.48) + (viewportWidth * 0.52), 0, viewportWidth),
      y: clamp((languagePoint.y * 0.6) + (viewportHeight * 0.4), 0, viewportHeight)
    };
    const alternateFieldPoint = {
      x: clamp((viewportWidth - languagePoint.x) * 0.72, 0, viewportWidth),
      y: clamp((languagePoint.y * 0.32) + (viewportHeight * 0.58), 0, viewportHeight)
    };

    svg.append(definitions);

    system.className = "threshold-system";
    system.dataset.mode = mode;
    system.dataset.mask = modeSelection.capabilities.supportsMask ? "supported" : "unavailable";
    system.setAttribute("aria-hidden", "true");
    system.setAttribute("inert", "");
    system.style.setProperty("--threshold-origin-x", `${origin.x}px`);
    system.style.setProperty("--threshold-origin-y", `${origin.y}px`);
    system.style.setProperty("--threshold-language-x", `${languagePoint.x}px`);
    system.style.setProperty("--threshold-language-y", `${languagePoint.y}px`);
    system.style.setProperty("--threshold-field-x", `${fieldPoint.x}px`);
    system.style.setProperty("--threshold-field-y", `${fieldPoint.y}px`);
    system.style.setProperty("--threshold-field-alt-x", `${alternateFieldPoint.x}px`);
    system.style.setProperty("--threshold-field-alt-y", `${alternateFieldPoint.y}px`);
    system.style.setProperty("--threshold-optical-background", window.getComputedStyle(document.body).backgroundColor);

    optical.className = "threshold-optical";
    optical.setAttribute("aria-hidden", "true");
    optical.setAttribute("inert", "");

    primaryLayer.className = "threshold-optical__layer threshold-optical__layer--primary";
    primaryLayer.style.setProperty("--threshold-layer-filter", `url(#${primaryFilterId})`);

    languageLayer.className = "threshold-optical__layer threshold-optical__layer--language";
    languageLayer.style.setProperty("--threshold-layer-filter", `url(#${languageFilterId})`);

    optical.append(baseLayer, primaryLayer);

    let secondaryLayer = null;
    if (mode === "full") {
      secondaryLayer = baseLayer.cloneNode(true);
      secondaryLayer.className = "threshold-optical__layer threshold-optical__layer--secondary";
      secondaryLayer.style.setProperty("--threshold-layer-filter", `url(#${secondaryFilterId})`);
      optical.append(secondaryLayer);
    }

    optical.append(languageLayer);

    blackGuard.className = "threshold-black-guard";
    blackGuard.setAttribute("aria-hidden", "true");

    system.append(svg, optical, blackGuard);

    return {
      system,
      svg,
      optical,
      blackGuard,
      primaryDisplacement,
      secondaryDisplacement,
      languageDisplacement,
      configuration
    };
  }

  function computeTimelineState(elapsed, timeline) {
    const [recognitionEnd, awakeningEnd, localizationEnd, presenceEnd, releaseEnd, silenceEnd] = timeline;

    if (elapsed < recognitionEnd) {
      const progress = easeOutCubic(segmentProgress(elapsed, 0, recognitionEnd));
      return {
        movement: "recognition",
        material: lerp(0.02, 0.08, progress),
        light: lerp(0.1, 0.24, progress),
        refraction: lerp(0, 0.05, progress),
        density: lerp(0, 0.08, progress),
        origin: lerp(1, 0.58, progress),
        release: 0,
        black: 0
      };
    }

    if (elapsed < awakeningEnd) {
      const progress = smoothstep(segmentProgress(elapsed, recognitionEnd, awakeningEnd));
      return {
        movement: "awakening",
        material: lerp(0.08, 0.26, progress),
        light: lerp(0.24, 0.58, progress),
        refraction: lerp(0.05, 0.24, progress),
        density: lerp(0.08, 0.28, progress),
        origin: lerp(0.58, 0.08, progress),
        release: 0,
        black: 0
      };
    }

    if (elapsed < localizationEnd) {
      const progress = smoothstep(segmentProgress(elapsed, awakeningEnd, localizationEnd));
      return {
        movement: "localization",
        material: lerp(0.26, 0.82, progress),
        light: lerp(0.58, 0.9, progress),
        refraction: lerp(0.24, 0.9, progress),
        density: lerp(0.28, 0.82, progress),
        origin: lerp(0.08, 0, progress),
        release: 0,
        black: 0
      };
    }

    if (elapsed < presenceEnd) {
      const progress = smoothstep(segmentProgress(elapsed, localizationEnd, presenceEnd));
      return {
        movement: "presence",
        material: lerp(0.82, 1, progress),
        light: lerp(0.9, 1, progress),
        refraction: lerp(0.9, 1, progress),
        density: lerp(0.82, 1, progress),
        origin: 0,
        release: 0,
        black: 0
      };
    }

    if (elapsed < releaseEnd) {
      const progress = smoothstep(segmentProgress(elapsed, presenceEnd, releaseEnd));
      return {
        movement: "release",
        material: lerp(1, 0.84, progress),
        light: lerp(1, 0, progress),
        refraction: lerp(1, 0.22, progress),
        density: lerp(1, 0.25, progress),
        origin: 0,
        release: progress,
        black: 0
      };
    }

    return {
      movement: elapsed < silenceEnd ? "silence" : "arrival",
      material: 0,
      light: 0,
      refraction: 0,
      density: 0,
      origin: 0,
      release: 1,
      black: 1
    };
  }

  function storeEntryMarker(mode, blackAt) {
    const marker = {
      version: MARKER_VERSION,
      source: "home",
      blackAt,
      mode
    };

    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(marker));
    } catch {
      // The marker coordinates silence only; the destination never depends on it.
    }
  }

  function cancelAnimationsWithin(element) {
    if (typeof element?.getAnimations !== "function") {
      return;
    }

    try {
      element.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
    } catch {
      // Removing the temporary tree remains the authoritative cleanup.
    }
  }

  class ThresholdController {
    constructor(link, destination, origin, modeSelection) {
      this.link = link;
      this.destination = destination;
      this.origin = origin;
      this.mode = modeSelection.name;
      this.modeSelection = modeSelection;
      this.resources = null;
      this.startTime = 0;
      this.frameRequest = 0;
      this.safetyTimer = 0;
      this.scrollX = window.scrollX;
      this.scrollY = window.scrollY;
      this.currentMovement = "idle";
      this.blackFrames = 0;
      this.blackPainted = false;
      this.blackAt = 0;
      this.navigationRequested = false;
      this.opticsRemoved = false;
      this.running = false;
      this.emergency = false;
      this.disposed = false;
      this.tick = this.tick.bind(this);
      this.handleKeydown = this.handleKeydown.bind(this);
      this.preventScroll = this.preventScroll.bind(this);
      this.holdScrollPosition = this.holdScrollPosition.bind(this);
      this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
      this.handlePageHide = this.handlePageHide.bind(this);
    }

    prepare() {
      const sources = collectVisibleSources();

      if (sources.length === 0) {
        throw new Error("No visible Home fragments were available for reconstruction.");
      }

      this.resources = createOpticalSystem(sources, this.origin, this.modeSelection);
      document.body.append(this.resources.system);
    }

    begin() {
      if (!this.resources?.system?.isConnected) {
        throw new Error("The optical reconstruction was not attached.");
      }

      this.running = true;
      this.startTime = performance.now();
      this.lockInteraction();
      this.applyState(computeTimelineState(0, this.resources.configuration.timeline));
      this.frameRequest = window.requestAnimationFrame(this.tick);
      this.safetyTimer = window.setTimeout(() => {
        this.completeImmediately();
      }, this.resources.configuration.safetyDelay);
    }

    lockInteraction() {
      const scrollbarGap = Math.max(0, window.innerWidth - root.clientWidth);
      root.style.setProperty("--threshold-scrollbar-gap", `${scrollbarGap}px`);
      root.classList.add("threshold-running");
      window.addEventListener("keydown", this.handleKeydown, true);
      window.addEventListener("wheel", this.preventScroll, { passive: false });
      window.addEventListener("touchmove", this.preventScroll, { passive: false });
      window.addEventListener("scroll", this.holdScrollPosition, { passive: true });
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
      window.addEventListener("pagehide", this.handlePageHide);
    }

    unlockInteraction({ restoreScroll = true } = {}) {
      window.removeEventListener("keydown", this.handleKeydown, true);
      window.removeEventListener("wheel", this.preventScroll, false);
      window.removeEventListener("touchmove", this.preventScroll, false);
      window.removeEventListener("scroll", this.holdScrollPosition, false);
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
      window.removeEventListener("pagehide", this.handlePageHide);
      root.classList.remove("threshold-running");
      root.style.removeProperty("--threshold-scrollbar-gap");

      if (restoreScroll) {
        window.scrollTo(this.scrollX, this.scrollY);
      }
    }

    preventScroll(event) {
      event.preventDefault();
    }

    holdScrollPosition() {
      if (window.scrollX !== this.scrollX || window.scrollY !== this.scrollY) {
        window.scrollTo(this.scrollX, this.scrollY);
      }
    }

    handleKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.completeImmediately();
        return;
      }

      if (SCROLL_KEYS.has(event.key)) {
        event.preventDefault();
      }
    }

    handleVisibilityChange() {
      if (document.hidden && this.running && !this.navigationRequested) {
        this.completeImmediately();
      }
    }

    handlePageHide() {
      this.dispose({ restoreScroll: false });
    }

    applyState(state) {
      if (!this.resources?.system) {
        return;
      }

      const { system, configuration } = this.resources;
      const releaseProgress = clamp(state.release ?? (state.black >= 1 ? 1 : 0));
      const opticalPresence = 1 - releaseProgress;
      const baseOpacity = opticalPresence;
      const primaryOpacity = clamp(
        state.material * (this.mode === "reduced" ? 0.34 : 0.72) * opticalPresence
      );
      const secondaryOpacity = clamp(state.material * 0.3 * opticalPresence);
      const languageOpacity = clamp(
        state.light * (this.mode === "reduced" ? 0.34 : 0.52) * opticalPresence
      );
      const maximumLanguageReach = this.mode === "reduced" ? 68 : 132;
      const languageReachX = lerp(16, maximumLanguageReach, clamp(state.light));
      const languageReachY = languageReachX * 0.72;
      const alternateLanguageReachX = languageReachX * 0.68;
      const alternateLanguageReachY = languageReachY * 0.92;

      system.style.setProperty("--threshold-base-opacity", baseOpacity.toFixed(4));
      system.style.setProperty("--threshold-primary-opacity", primaryOpacity.toFixed(4));
      system.style.setProperty("--threshold-secondary-opacity", secondaryOpacity.toFixed(4));
      system.style.setProperty("--threshold-language-opacity", languageOpacity.toFixed(4));
      system.style.setProperty("--threshold-black-opacity", clamp(state.black).toFixed(4));
      system.style.setProperty("--threshold-density-brightness", (1 + (state.density * 0.08)).toFixed(4));
      system.style.setProperty("--threshold-density-contrast", (1 + (state.density * 0.035)).toFixed(4));
      system.style.setProperty("--threshold-origin-presence", clamp(state.origin).toFixed(4));
      system.style.setProperty("--threshold-language-reach-x", `${languageReachX.toFixed(2)}vmax`);
      system.style.setProperty("--threshold-language-reach-y", `${languageReachY.toFixed(2)}vmax`);
      system.style.setProperty("--threshold-language-alt-reach-x", `${alternateLanguageReachX.toFixed(2)}vmax`);
      system.style.setProperty("--threshold-language-alt-reach-y", `${alternateLanguageReachY.toFixed(2)}vmax`);
      system.style.setProperty("--threshold-conduction-opacity", clamp(state.material).toFixed(4));

      if (state.movement !== this.currentMovement) {
        this.currentMovement = state.movement;
        system.dataset.movement = state.movement;
      }

      if (!this.opticsRemoved) {
        this.resources.primaryDisplacement?.setAttribute(
          "scale",
          (configuration.primaryDisplacement * state.refraction).toFixed(3)
        );
        this.resources.secondaryDisplacement?.setAttribute(
          "scale",
          (configuration.secondaryDisplacement * state.refraction).toFixed(3)
        );
        this.resources.languageDisplacement?.setAttribute(
          "scale",
          (configuration.languageDisplacement * state.refraction).toFixed(3)
        );
      }
    }

    tick(timestamp) {
      if (!this.running || this.disposed || this.navigationRequested) {
        return;
      }

      this.frameRequest = 0;

      try {
        const elapsed = this.emergency
          ? this.resources.configuration.timeline[4]
          : Math.max(0, timestamp - this.startTime);
        const state = this.emergency
          ? {
              movement: "silence",
              material: 0,
              light: 0,
              refraction: 0,
              density: 0,
              origin: 0,
              release: 1,
              black: 1
            }
          : computeTimelineState(elapsed, this.resources.configuration.timeline);

        this.applyState(state);

        if (state.black >= 0.999) {
          this.blackFrames += 1;
          if (this.blackFrames >= 2 && !this.blackPainted) {
            this.confirmPaintedBlack();
          }
        } else {
          this.blackFrames = 0;
        }

        const silenceEnd = this.resources.configuration.timeline[5];
        if (this.blackPainted && (this.emergency || elapsed >= silenceEnd)) {
          this.navigate();
          return;
        }

        this.frameRequest = window.requestAnimationFrame(this.tick);
      } catch {
        this.completeImmediately();
      }
    }

    confirmPaintedBlack() {
      this.blackPainted = true;
      this.blackAt = Date.now();
      storeEntryMarker(this.mode, this.blackAt);
      this.removeOpticalResources();
    }

    removeOpticalResources() {
      if (this.opticsRemoved || !this.resources) {
        return;
      }

      cancelAnimationsWithin(this.resources.optical);
      this.resources.optical?.remove();
      this.resources.svg?.remove();
      this.resources.optical = null;
      this.resources.svg = null;
      this.resources.primaryDisplacement = null;
      this.resources.secondaryDisplacement = null;
      this.resources.languageDisplacement = null;
      this.opticsRemoved = true;
    }

    completeImmediately() {
      if (this.disposed || this.navigationRequested) {
        return;
      }

      this.emergency = true;
      this.running = true;
      this.blackFrames = 0;

      try {
        this.applyState({
          movement: "silence",
          material: 0,
          light: 0,
          refraction: 0,
          density: 0,
          origin: 0,
          release: 1,
          black: 1
        });
      } catch {
        this.resources?.system?.style.setProperty("--threshold-black-opacity", "1");
      }

      if (!this.frameRequest) {
        this.frameRequest = window.requestAnimationFrame(this.tick);
      }
    }

    navigate() {
      if (this.navigationRequested || !this.blackPainted) {
        return;
      }

      this.navigationRequested = true;
      this.resources.system.dataset.movement = "arrival";
      window.cancelAnimationFrame(this.frameRequest);
      window.clearTimeout(this.safetyTimer);
      this.frameRequest = 0;
      this.safetyTimer = 0;
      window.removeEventListener("keydown", this.handleKeydown, true);
      window.removeEventListener("wheel", this.preventScroll, false);
      window.removeEventListener("touchmove", this.preventScroll, false);
      window.removeEventListener("scroll", this.holdScrollPosition, false);
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);

      try {
        window.location.assign(this.destination);
      } catch {
        this.navigationRequested = false;
        this.dispose();
      }
    }

    dispose({ restoreScroll = true } = {}) {
      if (this.disposed) {
        return;
      }

      this.disposed = true;
      this.running = false;
      window.cancelAnimationFrame(this.frameRequest);
      window.clearTimeout(this.safetyTimer);
      this.frameRequest = 0;
      this.safetyTimer = 0;
      this.unlockInteraction({ restoreScroll });
      cancelAnimationsWithin(this.resources?.system);
      this.resources?.system?.remove();
      this.resources = null;

      if (activeTransition === this) {
        activeTransition = null;
      }
    }
  }

  function resetThresholdState() {
    activeTransition?.dispose();
    document.querySelectorAll(".threshold-system").forEach((element) => element.remove());
    root.classList.remove("threshold-running");
    root.style.removeProperty("--threshold-scrollbar-gap");
    activeTransition = null;
  }

  function startTransition(event, link) {
    if (!isStandardActivation(event, link)) {
      return;
    }

    if (activeTransition) {
      event.preventDefault();
      return;
    }

    const modeSelection = selectExecutionMode();

    if (modeSelection.name === "essential") {
      return;
    }

    const origin = getOrigin(event, link);
    const controller = new ThresholdController(link, link.href, origin, modeSelection);

    try {
      controller.prepare();
    } catch {
      controller.dispose();
      return;
    }

    event.preventDefault();
    activeTransition = controller;

    try {
      controller.begin();
    } catch {
      controller.completeImmediately();
    }
  }

  document.addEventListener("pointerdown", (event) => {
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      !(event.target instanceof Element)
    ) {
      return;
    }

    const link = event.target.closest(ENTRY_SELECTOR);
    if (link instanceof HTMLAnchorElement) {
      pointerOrigins.set(link, {
        x: event.clientX,
        y: event.clientY,
        timestamp: performance.now()
      });
    }
  }, true);

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    const link = event.target.closest(ENTRY_SELECTOR);
    if (link instanceof HTMLAnchorElement) {
      startTransition(event, link);
    }
  });

  window.addEventListener("pagehide", () => {
    activeTransition?.dispose({ restoreScroll: false });
  });
  window.addEventListener("pageshow", resetThresholdState);
})();
