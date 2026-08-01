(() => {
  "use strict";

  const ENTRY_SELECTOR = "[data-game-localization-entry]";
  const ENTRY_ROUTE = "game-localization/";
  const STORAGE_KEY = "gameLocalizationEntry";
  const DIAGNOSTIC_STORAGE_KEY = "thresholdValidation";
  const MARKER_VERSION = 2;
  const DIAGNOSTIC_VERSION = 1;
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const LANGUAGE_SELECTOR = "h1, h2, h3, h4, h5, h6, p, a, li, summary, address, blockquote";
  const RECONSTRUCTION_OVERSCAN = 12;
  const MOVEMENT_ORDER = Object.freeze([
    "recognition",
    "awakening",
    "localization",
    "presence",
    "release",
    "silence",
    "arrival"
  ]);
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
    full: Object.freeze({
      timeline: [120, 350, 900, 1200, 1450, 1650],
      primaryDisplacement: 12,
      localizedDisplacement: 6,
      languageDisplacement: 2,
      domDisplacement: 4.5,
      originShift: 3,
      effectiveDensity: 1.75,
      pixelBudget: 6500000,
      languageRectLimit: 72,
      ruleRectLimit: 40,
      blockRectLimit: 20,
      safetyDelay: 3600
    }),
    lightweight: Object.freeze({
      timeline: [100, 300, 760, 1000, 1220, 1400],
      primaryDisplacement: 7,
      localizedDisplacement: 3.5,
      languageDisplacement: 1.2,
      domDisplacement: 3.5,
      originShift: 2.5,
      effectiveDensity: 1.5,
      pixelBudget: 3500000,
      languageRectLimit: 48,
      ruleRectLimit: 28,
      blockRectLimit: 14,
      safetyDelay: 3100
    }),
    reduced: Object.freeze({
      timeline: [90, 210, 390, 520, 640, 760],
      primaryDisplacement: 1.2,
      localizedDisplacement: 0.7,
      languageDisplacement: 0.3,
      domDisplacement: 1.1,
      originShift: 1.2,
      effectiveDensity: 1.25,
      pixelBudget: 2000000,
      languageRectLimit: 28,
      ruleRectLimit: 18,
      blockRectLimit: 8,
      safetyDelay: 2200
    }),
    essential: Object.freeze({
      timeline: [80, 180, 360, 470, 580, 700],
      primaryDisplacement: 0,
      localizedDisplacement: 0,
      languageDisplacement: 0,
      domDisplacement: 2.5,
      originShift: 2,
      effectiveDensity: 1,
      pixelBudget: 1500000,
      languageRectLimit: 24,
      ruleRectLimit: 14,
      blockRectLimit: 6,
      safetyDelay: 1900
    })
  });

  let activeTransition = null;
  let resourceSequence = 0;
  const pointerOrigins = new WeakMap();
  const declaredEntryRoutes = new WeakMap();
  const diagnosticOptions = readDiagnosticOptions();

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

  function scheduleFrame(callback) {
    if (typeof window.requestAnimationFrame === "function") {
      return window.requestAnimationFrame(callback);
    }

    return window.setTimeout(() => callback(performance.now()), 16);
  }

  function cancelFrame(identifier) {
    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(identifier);
      return;
    }

    window.clearTimeout(identifier);
  }

  function readDiagnosticOptions() {
    const parameters = new URLSearchParams(window.location.search);
    const enabled = parameters.get("threshold-debug") === "1";
    const requestedMode = parameters.get("threshold-mode");
    const forcedMode = enabled && Object.prototype.hasOwnProperty.call(MODE_CONFIG, requestedMode)
      ? requestedMode
      : null;

    return Object.freeze({
      enabled,
      forcedMode,
      forcePaintFailure: enabled && parameters.get("threshold-paint") === "fail"
    });
  }

  function currentDocumentDirectory(currentUrl) {
    const pathname = currentUrl.pathname || "/";

    if (pathname.endsWith("/")) {
      return pathname;
    }

    const lastSlash = pathname.lastIndexOf("/");
    const finalSegment = pathname.slice(lastSlash + 1);

    if (/^index(?:\.html?)?$/i.test(finalSegment) || /\.[a-z0-9]+$/i.test(finalSegment)) {
      return `${pathname.slice(0, lastSlash + 1)}` || "/";
    }

    return `${pathname}/`;
  }

  function resolveEntryDestination(link, currentHref = window.location.href) {
    const currentUrl = new URL(currentHref);
    const declaredRoute = declaredEntryRoutes.get(link)
      || link.getAttribute("href")
      || ENTRY_ROUTE;

    if (/^[a-z][a-z\d+.-]*:/i.test(declaredRoute) || declaredRoute.startsWith("//")) {
      return new URL(declaredRoute, currentUrl);
    }

    if (declaredRoute.startsWith("/")) {
      return new URL(declaredRoute, currentUrl.origin);
    }

    const baseUrl = new URL(currentUrl.href);
    baseUrl.pathname = currentDocumentDirectory(currentUrl);
    baseUrl.search = "";
    baseUrl.hash = "";

    const normalizedRoute = declaredRoute
      .replace(/^\.\//, "")
      || ENTRY_ROUTE;

    return new URL(normalizedRoute, baseUrl);
  }

  function stabilizeEntryLinks() {
    document.querySelectorAll(ENTRY_SELECTOR).forEach((element) => {
      if (!(element instanceof HTMLAnchorElement)) {
        return;
      }

      if (!declaredEntryRoutes.has(element)) {
        declaredEntryRoutes.set(element, element.getAttribute("href") || ENTRY_ROUTE);
      }

      try {
        element.href = resolveEntryDestination(element).href;
      } catch {
        // The authored href remains the no-JavaScript authority.
      }
    });
  }

  function isStandardActivation(event, link, destination) {
    return !(
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      link.target === "_blank" ||
      link.hasAttribute("download") ||
      destination.origin !== window.location.origin
    );
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
      window.CSS.supports("mask-image", "url(#threshold-mask)") ||
      window.CSS.supports("-webkit-mask-image", "url(#threshold-mask)")
    );
    const supportsSvg = typeof document.createElementNS === "function";
    const supportsAnimationFrame = typeof window.requestAnimationFrame === "function";

    return {
      supportsAdvancedOptics: supportsFilter && supportsSvg && supportsAnimationFrame,
      supportsMask,
      supportsAnimationFrame
    };
  }

  function selectExecutionMode() {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const capabilities = detectCapabilities();

    if (diagnosticOptions.forcedMode) {
      return { name: diagnosticOptions.forcedMode, capabilities, forced: true };
    }

    if (reduceMotion) {
      return { name: "reduced", capabilities, forced: false };
    }

    if (!capabilities.supportsAdvancedOptics || !capabilities.supportsMask) {
      return { name: "essential", capabilities, forced: false };
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const nativePixels = viewportWidth * viewportHeight * Math.pow(devicePixelRatio, 2);
    const deviceMemory = Number(navigator.deviceMemory);
    const hardwareConcurrency = Number(navigator.hardwareConcurrency);
    const memoryAllowsFull = Number.isFinite(deviceMemory)
      ? deviceMemory >= 4
      : viewportWidth >= 1024;
    const concurrencyAllowsFull = Number.isFinite(hardwareConcurrency)
      ? hardwareConcurrency >= 4
      : viewportWidth >= 1024;
    const fullModeIsStable = (
      viewportWidth >= 768 &&
      viewportHeight >= 520 &&
      nativePixels <= MODE_CONFIG.full.pixelBudget &&
      memoryAllowsFull &&
      concurrencyAllowsFull
    );

    return {
      name: fullModeIsStable ? "full" : "lightweight",
      capabilities,
      forced: false
    };
  }

  function viewportBounds() {
    return {
      top: -RECONSTRUCTION_OVERSCAN,
      right: window.innerWidth + RECONSTRUCTION_OVERSCAN,
      bottom: window.innerHeight + RECONSTRUCTION_OVERSCAN,
      left: -RECONSTRUCTION_OVERSCAN
    };
  }

  function rectIntersectsViewport(bounds, overscan = RECONSTRUCTION_OVERSCAN) {
    return (
      bounds.width > 0 &&
      bounds.height > 0 &&
      bounds.bottom > -overscan &&
      bounds.right > -overscan &&
      bounds.top < window.innerHeight + overscan &&
      bounds.left < window.innerWidth + overscan
    );
  }

  function elementIntersectsViewport(element, overscan = RECONSTRUCTION_OVERSCAN) {
    const bounds = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);

    return (
      rectIntersectsViewport(bounds, overscan) &&
      styles.display !== "none" &&
      styles.visibility !== "hidden" &&
      Number.parseFloat(styles.opacity || "1") > 0
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

  function visibleRect(bounds) {
    const viewport = viewportBounds();
    const left = clamp(bounds.left, viewport.left, viewport.right);
    const right = clamp(bounds.right, viewport.left, viewport.right);
    const top = clamp(bounds.top, viewport.top, viewport.bottom);
    const bottom = clamp(bounds.bottom, viewport.top, viewport.bottom);

    return {
      x: left,
      y: top,
      left,
      right,
      top,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top)
    };
  }

  function collectLanguageRects(sources, limit) {
    const rectangles = [];
    const keys = new Set();

    sources.forEach((source) => {
      const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();

      while (textNode && rectangles.length < limit) {
        const parent = textNode.parentElement;
        const text = textNode.textContent.trim();

        if (text && parent?.closest(LANGUAGE_SELECTOR) && elementIntersectsViewport(parent, 2)) {
          const range = document.createRange();
          range.selectNodeContents(textNode);

          Array.from(range.getClientRects()).forEach((bounds) => {
            if (!rectIntersectsViewport(bounds, 2) || rectangles.length >= limit) {
              return;
            }

            const rectangle = visibleRect(bounds);
            const key = [
              Math.round(rectangle.left),
              Math.round(rectangle.top),
              Math.round(rectangle.width),
              Math.round(rectangle.height)
            ].join(":");

            if (rectangle.width > 1 && rectangle.height > 1 && !keys.has(key)) {
              keys.add(key);
              rectangles.push(rectangle);
            }
          });

          range.detach?.();
        }

        textNode = walker.nextNode();
      }
    });

    return rectangles;
  }

  function parseBorderWidth(styles, side) {
    const style = styles[`border${side}Style`];
    const width = Number.parseFloat(styles[`border${side}Width`] || "0");
    return style !== "none" && style !== "hidden" && width > 0 ? width : 0;
  }

  function collectRuleRects(sources, limit) {
    const rules = [];
    const seen = new Set();

    function addRule(rectangle, color) {
      if (rules.length >= limit || rectangle.width <= 0 || rectangle.height <= 0) {
        return;
      }

      const clipped = visibleRect(rectangle);
      const key = [
        Math.round(clipped.left),
        Math.round(clipped.top),
        Math.round(clipped.width),
        Math.round(clipped.height)
      ].join(":");

      if (clipped.width > 0 && clipped.height > 0 && !seen.has(key)) {
        seen.add(key);
        rules.push({ ...clipped, color });
      }
    }

    sources.forEach((source) => {
      const candidates = [source, ...source.querySelectorAll("*")];

      for (const element of candidates) {
        if (rules.length >= limit || !elementIntersectsViewport(element, 2)) {
          continue;
        }

        const bounds = element.getBoundingClientRect();
        const styles = window.getComputedStyle(element);
        const top = parseBorderWidth(styles, "Top");
        const right = parseBorderWidth(styles, "Right");
        const bottom = parseBorderWidth(styles, "Bottom");
        const left = parseBorderWidth(styles, "Left");

        if (top) {
          addRule({
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            bottom: bounds.top + top,
            width: bounds.width,
            height: top
          }, styles.borderTopColor);
        }
        if (right) {
          addRule({
            left: bounds.right - right,
            right: bounds.right,
            top: bounds.top,
            bottom: bounds.bottom,
            width: right,
            height: bounds.height
          }, styles.borderRightColor);
        }
        if (bottom) {
          addRule({
            left: bounds.left,
            right: bounds.right,
            top: bounds.bottom - bottom,
            bottom: bounds.bottom,
            width: bounds.width,
            height: bottom
          }, styles.borderBottomColor);
        }
        if (left) {
          addRule({
            left: bounds.left,
            right: bounds.left + left,
            top: bounds.top,
            bottom: bounds.bottom,
            width: left,
            height: bounds.height
          }, styles.borderLeftColor);
        }
      }
    });

    return rules;
  }

  function collectBlockRects(sources, limit) {
    const blocks = [];
    const seen = new Set();
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);

    sources.forEach((source) => {
      const candidates = [source, ...source.querySelectorAll("div, section, header, footer, nav, article")];

      for (const element of candidates) {
        if (blocks.length >= limit || !elementIntersectsViewport(element, 4)) {
          continue;
        }

        const bounds = visibleRect(element.getBoundingClientRect());
        const area = bounds.width * bounds.height;
        const styles = window.getComputedStyle(element);
        const isStructuralDisplay = ["block", "flex", "grid"].includes(styles.display);

        if (
          !isStructuralDisplay ||
          element.childElementCount === 0 ||
          area < viewportArea * 0.012 ||
          area > viewportArea * 0.94
        ) {
          continue;
        }

        const key = [
          Math.round(bounds.left / 8),
          Math.round(bounds.top / 8),
          Math.round(bounds.width / 8),
          Math.round(bounds.height / 8)
        ].join(":");

        if (!seen.has(key)) {
          seen.add(key);
          blocks.push(bounds);
        }
      }
    });

    return blocks;
  }

  function rectCenter(rectangle) {
    return {
      x: rectangle.left + (rectangle.width / 2),
      y: rectangle.top + (rectangle.height / 2)
    };
  }

  function collectEditorialGeometry(sources, origin, configuration) {
    const languageRects = collectLanguageRects(sources, configuration.languageRectLimit);
    const ruleRects = collectRuleRects(sources, configuration.ruleRectLimit);
    const blockRects = collectBlockRects(sources, configuration.blockRectLimit);
    let nearestLanguageRect = languageRects[0] || {
      left: origin.x - 8,
      right: origin.x + 8,
      top: origin.y - 8,
      bottom: origin.y + 8,
      width: 16,
      height: 16
    };
    let nearestDistance = Number.POSITIVE_INFINITY;

    languageRects.forEach((rectangle) => {
      const center = rectCenter(rectangle);
      const distance = Math.hypot(center.x - origin.x, center.y - origin.y);

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestLanguageRect = rectangle;
      }
    });

    return { languageRects, ruleRects, blockRects, nearestLanguageRect };
  }

  function removeActiveAttributes(element) {
    Array.from(element.attributes).forEach((attribute) => {
      if (
        attribute.name === "id" ||
        attribute.name === "name" ||
        attribute.name === "for" ||
        attribute.name === "form" ||
        attribute.name === "role" ||
        attribute.name.startsWith("on") ||
        attribute.name.startsWith("aria-")
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

  function configureOffscreenPlaceholder(source, clone, stats) {
    const bounds = source.getBoundingClientRect();
    const styles = window.getComputedStyle(source);

    clone.replaceChildren();
    clone.setAttribute("data-threshold-placeholder", "");
    clone.setAttribute("aria-hidden", "true");
    clone.style.setProperty("visibility", "hidden", "important");
    clone.style.setProperty("pointer-events", "none", "important");
    clone.style.setProperty("box-sizing", "border-box", "important");
    clone.style.setProperty("width", `${Math.max(0, bounds.width)}px`, "important");
    clone.style.setProperty("height", `${Math.max(0, bounds.height)}px`, "important");
    clone.style.setProperty("min-width", "0", "important");
    clone.style.setProperty("min-height", "0", "important");
    clone.style.setProperty("flex", "0 0 auto", "important");

    if (styles.display === "inline") {
      clone.style.setProperty("display", "inline-block", "important");
    }

    stats.prunedElements += 1;
  }

  function cloneVisibleSubtree(source, stats) {
    const clone = source.cloneNode(false);

    function populate(sourceElement, cloneElement) {
      removeActiveAttributes(cloneElement);
      stats.clonedElements += 1;

      if (isLanguageElement(sourceElement)) {
        cloneElement.setAttribute("data-threshold-language", "");
      }

      sourceElement.childNodes.forEach((sourceNode) => {
        if (sourceNode.nodeType === Node.TEXT_NODE) {
          cloneElement.append(sourceNode.cloneNode());
          return;
        }

        if (!(sourceNode instanceof Element) || sourceNode.matches("script, style, template, noscript")) {
          return;
        }

        const childClone = sourceNode.cloneNode(false);
        removeActiveAttributes(childClone);
        cloneElement.append(childClone);

        const bounds = sourceNode.getBoundingClientRect();
        const styles = window.getComputedStyle(sourceNode);
        const hasBox = bounds.width > 0 && bounds.height > 0 && styles.display !== "contents";
        const visible = elementIntersectsViewport(sourceNode);

        if (hasBox && !visible) {
          configureOffscreenPlaceholder(sourceNode, childClone, stats);
          return;
        }

        populate(sourceNode, childClone);
      });
    }

    populate(source, clone);
    return clone;
  }

  function createVisibleLayer(sources, stats) {
    const layer = document.createElement("div");
    layer.className = "threshold-optical__layer";

    sources.forEach((source, index) => {
      const bounds = source.getBoundingClientRect();
      const clipTop = Math.max(-RECONSTRUCTION_OVERSCAN, bounds.top);
      const clipRight = Math.min(window.innerWidth + RECONSTRUCTION_OVERSCAN, bounds.right);
      const clipBottom = Math.min(window.innerHeight + RECONSTRUCTION_OVERSCAN, bounds.bottom);
      const clipLeft = Math.max(-RECONSTRUCTION_OVERSCAN, bounds.left);
      const clipWidth = Math.max(0, clipRight - clipLeft);
      const clipHeight = Math.max(0, clipBottom - clipTop);

      if (clipWidth === 0 || clipHeight === 0) {
        return;
      }

      const fragment = document.createElement("div");
      const clone = cloneVisibleSubtree(source, stats);
      const centerX = clipLeft + (clipWidth / 2);
      const centerY = clipTop + (clipHeight / 2);
      const horizontalDirection = clamp((centerX - (window.innerWidth / 2)) / Math.max(1, window.innerWidth / 2), -1, 1);
      const verticalDirection = clamp((centerY - (window.innerHeight / 2)) / Math.max(1, window.innerHeight / 2), -1, 1);

      fragment.className = "threshold-optical__fragment";
      fragment.dataset.fragmentIndex = String(index);
      fragment.dataset.directionX = String(horizontalDirection || (index % 2 === 0 ? -0.35 : 0.35));
      fragment.dataset.directionY = String(verticalDirection || (index % 3 === 0 ? -0.22 : 0.22));
      fragment.style.top = `${clipTop}px`;
      fragment.style.left = `${clipLeft}px`;
      fragment.style.width = `${clipWidth}px`;
      fragment.style.height = `${clipHeight}px`;

      clone.setAttribute("data-threshold-optical-clone", "");
      clone.style.setProperty("position", "absolute", "important");
      clone.style.setProperty("top", `${bounds.top - clipTop}px`, "important");
      clone.style.setProperty("left", `${bounds.left - clipLeft}px`, "important");
      clone.style.setProperty("width", `${bounds.width}px`, "important");
      clone.style.setProperty("height", `${bounds.height}px`, "important");
      clone.style.setProperty("margin", "0", "important");
      clone.style.setProperty("pointer-events", "none", "important");
      clone.setAttribute("aria-hidden", "true");

      fragment.append(clone);
      layer.append(fragment);
      stats.visibleFragments += 1;
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
    const margin = settings.margin;
    const filter = createSvgElement("filter", {
      id,
      x: -margin,
      y: -margin,
      width: settings.viewportWidth + (margin * 2),
      height: settings.viewportHeight + (margin * 2),
      filterUnits: "userSpaceOnUse",
      primitiveUnits: "userSpaceOnUse",
      "color-interpolation-filters": "sRGB"
    });
    const turbulence = createSvgElement("feTurbulence", {
      type: "fractalNoise",
      baseFrequency: settings.baseFrequency,
      numOctaves: "1",
      seed: settings.seed,
      stitchTiles: "stitch",
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
    return { filter, displacement };
  }

  function expandedPolygon(rectangle, expansion, index = 0) {
    const left = clamp(rectangle.left - expansion, -RECONSTRUCTION_OVERSCAN, window.innerWidth + RECONSTRUCTION_OVERSCAN);
    const right = clamp(rectangle.right + expansion, -RECONSTRUCTION_OVERSCAN, window.innerWidth + RECONSTRUCTION_OVERSCAN);
    const top = clamp(rectangle.top - expansion, -RECONSTRUCTION_OVERSCAN, window.innerHeight + RECONSTRUCTION_OVERSCAN);
    const bottom = clamp(rectangle.bottom + expansion, -RECONSTRUCTION_OVERSCAN, window.innerHeight + RECONSTRUCTION_OVERSCAN);
    const skewX = Math.min(Math.max(2, (right - left) * 0.08), 18) * (index % 2 === 0 ? 1 : -1);
    const skewY = Math.min(Math.max(1, (bottom - top) * 0.12), 12) * (index % 3 === 0 ? -1 : 1);

    return [
      `${left + Math.max(0, skewX)} ${top}`,
      `${right} ${top + Math.max(0, skewY)}`,
      `${right - Math.max(0, -skewX)} ${bottom}`,
      `${left} ${bottom - Math.max(0, -skewY)}`
    ].join(" ");
  }

  function createStructureMasks(definitions, ids, geometry, origin) {
    const originMask = createSvgElement("mask", {
      id: ids.origin,
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      maskUnits: "userSpaceOnUse",
      maskContentUnits: "userSpaceOnUse",
      "mask-type": "luminance"
    });
    const conductionMask = createSvgElement("mask", {
      id: ids.conduction,
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      maskUnits: "userSpaceOnUse",
      maskContentUnits: "userSpaceOnUse",
      "mask-type": "luminance"
    });
    const probeMask = createSvgElement("mask", {
      id: ids.probe,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      maskUnits: "objectBoundingBox",
      maskContentUnits: "objectBoundingBox",
      "mask-type": "luminance"
    });
    const nearest = geometry.nearestLanguageRect;
    const originBounds = {
      left: Math.min(origin.x, nearest.left),
      right: Math.max(origin.x, nearest.right),
      top: Math.min(origin.y, nearest.top),
      bottom: Math.max(origin.y, nearest.bottom),
      width: Math.max(8, Math.max(origin.x, nearest.right) - Math.min(origin.x, nearest.left)),
      height: Math.max(8, Math.max(origin.y, nearest.bottom) - Math.min(origin.y, nearest.top))
    };

    originMask.append(createSvgElement("rect", {
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      fill: "black"
    }));
    originMask.append(
      createSvgElement("polygon", {
        points: expandedPolygon(originBounds, 7, 1),
        fill: "white",
        opacity: 0.92
      }),
      createSvgElement("polygon", {
        points: expandedPolygon(nearest, 3, 2),
        fill: "white"
      })
    );

    conductionMask.append(createSvgElement("rect", {
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      fill: "black"
    }));

    geometry.languageRects.forEach((rectangle, index) => {
      conductionMask.append(
        createSvgElement("polygon", {
          points: expandedPolygon(rectangle, 10 + (index % 3) * 3, index),
          fill: "white",
          opacity: 0.28
        }),
        createSvgElement("polygon", {
          points: expandedPolygon(rectangle, 2, index + 1),
          fill: "white",
          opacity: 0.92
        })
      );
    });

    geometry.ruleRects.forEach((rectangle, index) => {
      conductionMask.append(createSvgElement("polygon", {
        points: expandedPolygon(rectangle, 5 + (index % 2) * 3, index),
        fill: "white",
        opacity: 0.8
      }));
    });

    geometry.blockRects.forEach((rectangle, index) => {
      conductionMask.append(createSvgElement("polygon", {
        points: expandedPolygon(rectangle, -Math.min(18, rectangle.width * 0.05), index + 2),
        fill: "white",
        opacity: 0.2 + ((index % 3) * 0.06)
      }));
    });

    const languageCenters = geometry.languageRects.slice(0, 10).map(rectCenter);
    if (languageCenters.length > 1) {
      const pathData = languageCenters
        .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
        .join(" ");
      conductionMask.append(createSvgElement("path", {
        d: pathData,
        fill: "none",
        stroke: "white",
        "stroke-width": Math.max(10, Math.min(28, window.innerWidth * 0.018)),
        "stroke-linecap": "butt",
        "stroke-linejoin": "bevel",
        opacity: 0.24
      }));
    }

    probeMask.append(createSvgElement("polygon", {
      points: "0.08 0 1 0.12 0.88 1 0 0.82",
      fill: "white"
    }));

    definitions.append(originMask, conductionMask, probeMask);
  }

  function originClipPath(origin, nearest) {
    const left = clamp(Math.min(origin.x, nearest.left) - 8, -RECONSTRUCTION_OVERSCAN, window.innerWidth + RECONSTRUCTION_OVERSCAN);
    const right = clamp(Math.max(origin.x, nearest.right) + 10, -RECONSTRUCTION_OVERSCAN, window.innerWidth + RECONSTRUCTION_OVERSCAN);
    const top = clamp(Math.min(origin.y, nearest.top) - 6, -RECONSTRUCTION_OVERSCAN, window.innerHeight + RECONSTRUCTION_OVERSCAN);
    const bottom = clamp(Math.max(origin.y, nearest.bottom) + 8, -RECONSTRUCTION_OVERSCAN, window.innerHeight + RECONSTRUCTION_OVERSCAN);
    const insetX = Math.min(12, Math.max(3, (right - left) * 0.1));
    const insetY = Math.min(8, Math.max(2, (bottom - top) * 0.12));

    return `polygon(${[
      `${left + insetX}px ${top}px`,
      `${right}px ${top + insetY}px`,
      `${right - (insetX * 0.45)}px ${bottom}px`,
      `${left}px ${bottom - (insetY * 0.6)}px`
    ].join(", ")})`;
  }

  function createRuleLayer(ruleRects) {
    const layer = document.createElement("div");
    layer.className = "threshold-optical__rules";

    ruleRects.forEach((rectangle, index) => {
      const rule = document.createElement("span");
      rule.className = "threshold-optical__rule";
      rule.dataset.directionX = String(index % 2 === 0 ? -0.45 : 0.45);
      rule.dataset.directionY = String(index % 3 === 0 ? -0.24 : 0.24);
      rule.style.left = `${rectangle.left}px`;
      rule.style.top = `${rectangle.top}px`;
      rule.style.width = `${rectangle.width}px`;
      rule.style.height = `${Math.max(1, rectangle.height)}px`;
      rule.style.backgroundColor = rectangle.color;
      layer.append(rule);
    });

    return layer;
  }

  function createPaintProbe(filterId, maskId) {
    const probe = document.createElement("div");
    probe.className = "threshold-paint-probe";
    probe.setAttribute("aria-hidden", "true");
    probe.style.setProperty("--threshold-layer-filter", `url(#${filterId})`);
    probe.style.setProperty("--threshold-layer-mask", `url(#${maskId})`);
    return probe;
  }

  function createOpticalSystem(sources, origin, modeSelection) {
    const mode = modeSelection.name;
    const configuration = MODE_CONFIG[mode];
    const sequence = ++resourceSequence;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const densityWithinBudget = Math.sqrt(configuration.pixelBudget / Math.max(1, viewportWidth * viewportHeight));
    const effectiveDensity = Math.max(0.75, Math.min(
      devicePixelRatio,
      configuration.effectiveDensity,
      densityWithinBudget
    ));
    const samplingScale = clamp(effectiveDensity / devicePixelRatio, 0.25, 1);
    const renderPixels = Math.round(viewportWidth * viewportHeight * Math.pow(effectiveDensity, 2));
    const canAttemptSvg = (
      mode !== "essential" &&
      mode !== "reduced" &&
      modeSelection.capabilities.supportsAdvancedOptics &&
      modeSelection.capabilities.supportsMask
    );
    const ids = {
      primaryFilter: `threshold-refraction-primary-${sequence}`,
      localizedFilter: `threshold-refraction-localized-${sequence}`,
      languageFilter: `threshold-refraction-language-${sequence}`,
      originMask: `threshold-origin-mask-${sequence}`,
      conductionMask: `threshold-conduction-mask-${sequence}`,
      probeMask: `threshold-probe-mask-${sequence}`
    };
    const stats = { visibleFragments: 0, clonedElements: 0, prunedElements: 0 };
    const geometry = collectEditorialGeometry(sources, origin, configuration);
    const system = document.createElement("div");
    const budgetSurface = document.createElement("div");
    const optical = document.createElement("div");
    const templateLayer = createVisibleLayer(sources, stats);
    const originLayer = templateLayer.cloneNode(true);
    const languageLayer = templateLayer.cloneNode(true);
    const conductionLayer = templateLayer.cloneNode(true);
    const materialLayer = templateLayer.cloneNode(true);
    const ruleLayer = createRuleLayer(geometry.ruleRects);
    const blackGuard = document.createElement("div");
    let svg = null;
    let paintProbe = null;
    let primaryDisplacement = null;
    let localizedDisplacement = null;
    let languageDisplacement = null;

    system.className = "threshold-system";
    system.dataset.mode = mode;
    system.dataset.optics = canAttemptSvg ? "svg-pending" : "dom";
    system.setAttribute("aria-hidden", "true");
    system.setAttribute("inert", "");
    if ("inert" in system) {
      system.inert = true;
    }
    system.style.setProperty("--threshold-origin-x", `${origin.x}px`);
    system.style.setProperty("--threshold-origin-y", `${origin.y}px`);
    system.style.setProperty("--threshold-origin-clip", originClipPath(origin, geometry.nearestLanguageRect));
    system.style.setProperty("--threshold-optical-background", window.getComputedStyle(document.body).backgroundColor);

    optical.className = "threshold-optical";
    optical.setAttribute("aria-hidden", "true");
    optical.setAttribute("inert", "");
    if ("inert" in optical) {
      optical.inert = true;
    }
    optical.style.width = `${viewportWidth}px`;
    optical.style.height = `${viewportHeight}px`;
    optical.style.transform = `scale(${samplingScale})`;

    budgetSurface.className = "threshold-optical-budget";
    budgetSurface.setAttribute("aria-hidden", "true");
    budgetSurface.setAttribute("inert", "");
    budgetSurface.style.width = `${viewportWidth * samplingScale}px`;
    budgetSurface.style.height = `${viewportHeight * samplingScale}px`;
    budgetSurface.style.transform = `scale(${1 / samplingScale})`;
    if ("inert" in budgetSurface) {
      budgetSurface.inert = true;
    }

    originLayer.className = "threshold-optical__layer threshold-optical__layer--origin";
    languageLayer.className = "threshold-optical__layer threshold-optical__layer--language";
    conductionLayer.className = "threshold-optical__layer threshold-optical__layer--conduction";
    materialLayer.className = "threshold-optical__layer threshold-optical__layer--material";

    if (canAttemptSvg) {
      svg = createSvgElement("svg", {
        class: "threshold-system__svg",
        "aria-hidden": "true",
        focusable: "false",
        width: "0",
        height: "0"
      });
      const definitions = createSvgElement("defs");
      const margin = Math.max(18, Math.ceil(configuration.primaryDisplacement * 2));
      const primary = createDisplacementFilter(definitions, ids.primaryFilter, {
        viewportWidth,
        viewportHeight,
        margin,
        baseFrequency: mode === "full" ? "0.008 0.015" : "0.011 0.018",
        seed: "11",
        xChannel: "R",
        yChannel: "B"
      });
      const localized = createDisplacementFilter(definitions, ids.localizedFilter, {
        viewportWidth,
        viewportHeight,
        margin,
        baseFrequency: mode === "full" ? "0.014 0.009" : "0.016 0.012",
        seed: "23",
        xChannel: "B",
        yChannel: "G"
      });
      const language = createDisplacementFilter(definitions, ids.languageFilter, {
        viewportWidth,
        viewportHeight,
        margin,
        baseFrequency: mode === "full" ? "0.01 0.013" : "0.014 0.016",
        seed: "31",
        xChannel: "B",
        yChannel: "G"
      });

      primaryDisplacement = primary.displacement;
      localizedDisplacement = localized.displacement;
      languageDisplacement = language.displacement;
      createStructureMasks(definitions, {
        origin: ids.originMask,
        conduction: ids.conductionMask,
        probe: ids.probeMask
      }, geometry, origin);
      svg.append(definitions);

      originLayer.style.setProperty("--threshold-layer-filter", `url(#${ids.localizedFilter})`);
      originLayer.style.setProperty("--threshold-layer-mask", `url(#${ids.originMask})`);
      languageLayer.style.setProperty("--threshold-layer-filter", `url(#${ids.languageFilter})`);
      conductionLayer.style.setProperty("--threshold-layer-filter", `url(#${ids.localizedFilter})`);
      conductionLayer.style.setProperty("--threshold-layer-mask", `url(#${ids.conductionMask})`);
      materialLayer.style.setProperty("--threshold-layer-filter", `url(#${ids.primaryFilter})`);
      paintProbe = createPaintProbe(ids.primaryFilter, ids.probeMask);
    }

    optical.append(originLayer, conductionLayer, ruleLayer, materialLayer, languageLayer);

    blackGuard.className = "threshold-black-guard";
    blackGuard.setAttribute("aria-hidden", "true");

    if (svg) {
      system.append(svg);
    }
    if (paintProbe) {
      system.append(paintProbe);
    }
    budgetSurface.append(optical);
    system.append(budgetSurface, blackGuard);

    const transformTargets = [];
    [originLayer, conductionLayer, materialLayer, languageLayer].forEach((layer) => {
      const kind = layer.className.split("--").pop();
      layer.querySelectorAll(".threshold-optical__fragment").forEach((fragment) => {
        const clone = fragment.querySelector(":scope > [data-threshold-optical-clone]");
        if (!clone) {
          return;
        }

        transformTargets.push({
          element: clone,
          kind,
          directionX: Number(fragment.dataset.directionX) || 0,
          directionY: Number(fragment.dataset.directionY) || 0
        });
      });
    });

    ruleLayer.querySelectorAll(".threshold-optical__rule").forEach((rule) => {
      transformTargets.push({
        element: rule,
        kind: "rules",
        directionX: Number(rule.dataset.directionX) || 0,
        directionY: Number(rule.dataset.directionY) || 0
      });
    });

    return {
      system,
      svg,
      budgetSurface,
      optical,
      blackGuard,
      paintProbe,
      originLayer,
      languageLayer,
      conductionLayer,
      materialLayer,
      primaryDisplacement,
      localizedDisplacement,
      languageDisplacement,
      transformTargets,
      configuration,
      stats,
      engine: canAttemptSvg ? "svg-pending" : "dom",
      expectedFilters: canAttemptSvg
        ? [
            { target: materialLayer, id: ids.primaryFilter },
            { target: conductionLayer, id: ids.localizedFilter },
            { target: languageLayer, id: ids.languageFilter },
            { target: paintProbe, id: ids.primaryFilter }
          ]
        : [],
      expectedMasks: canAttemptSvg
        ? [
            { target: paintProbe, id: ids.probeMask },
            { target: originLayer, id: ids.originMask },
            { target: conductionLayer, id: ids.conductionMask }
          ]
        : [],
      budget: {
        viewportWidth,
        viewportHeight,
        nativeDensity: devicePixelRatio,
        effectiveDensity,
        samplingScale,
        renderPixels,
        pixelBudget: configuration.pixelBudget
      }
    };
  }

  function computeTimelineState(elapsed, timeline) {
    const [recognitionEnd, awakeningEnd, localizationEnd, presenceEnd, releaseEnd, silenceEnd] = timeline;

    if (elapsed < recognitionEnd) {
      const progress = easeOutCubic(segmentProgress(elapsed, 0, recognitionEnd));
      return {
        movement: "recognition",
        origin: lerp(1, 0.42, progress),
        language: lerp(0.22, 0.52, progress),
        conduction: 0,
        material: 0,
        light: lerp(0.2, 0.48, progress),
        refraction: lerp(0.04, 0.12, progress),
        density: lerp(0.04, 0.14, progress),
        release: 0,
        materialLuminance: 1,
        black: 0
      };
    }

    if (elapsed < awakeningEnd) {
      const progress = smoothstep(segmentProgress(elapsed, recognitionEnd, awakeningEnd));
      const conduction = smoothstep(clamp((progress - 0.28) / 0.72));
      const material = smoothstep(clamp((progress - 0.76) / 0.24));
      return {
        movement: "awakening",
        origin: lerp(0.42, 0, progress),
        language: lerp(0.52, 1, progress),
        conduction: conduction * 0.55,
        material: material * 0.1,
        light: lerp(0.48, 0.72, progress),
        refraction: lerp(0.12, 0.34, progress),
        density: lerp(0.14, 0.36, progress),
        release: 0,
        materialLuminance: 1,
        black: 0
      };
    }

    if (elapsed < localizationEnd) {
      const progress = smoothstep(segmentProgress(elapsed, awakeningEnd, localizationEnd));
      return {
        movement: "localization",
        origin: 0,
        language: 1,
        conduction: lerp(0.55, 1, progress),
        material: lerp(0.1, 0.92, smoothstep(clamp((progress - 0.08) / 0.92))),
        light: lerp(0.72, 0.94, progress),
        refraction: lerp(0.34, 0.92, progress),
        density: lerp(0.36, 0.9, progress),
        release: 0,
        materialLuminance: 1,
        black: 0
      };
    }

    if (elapsed < presenceEnd) {
      const progress = smoothstep(segmentProgress(elapsed, localizationEnd, presenceEnd));
      return {
        movement: "presence",
        origin: 0,
        language: 1,
        conduction: 1,
        material: lerp(0.92, 1, progress),
        light: lerp(0.94, 1, progress),
        refraction: lerp(0.92, 1, progress),
        density: lerp(0.9, 1, progress),
        release: 0,
        materialLuminance: 1,
        black: 0
      };
    }

    if (elapsed < releaseEnd) {
      const progress = smoothstep(segmentProgress(elapsed, presenceEnd, releaseEnd));
      return {
        movement: "release",
        origin: 0,
        language: 1 - progress,
        conduction: 1 - (progress * 0.92),
        material: 1,
        light: 1 - progress,
        refraction: lerp(1, 0.18, progress),
        density: lerp(1, 0.18, progress),
        release: progress,
        materialLuminance: 1 - progress,
        black: 0
      };
    }

    return {
      movement: elapsed < silenceEnd ? "silence" : "arrival",
      origin: 0,
      language: 0,
      conduction: 0,
      material: 1,
      light: 0,
      refraction: 0,
      density: 0,
      release: 1,
      materialLuminance: 0,
      black: 1
    };
  }

  function safeDestinationForDiagnostics(destination) {
    try {
      const url = new URL(destination);
      return `${url.origin}${url.pathname}`;
    } catch {
      return String(destination);
    }
  }

  class ThresholdDiagnostics {
    constructor(destination, modeSelection) {
      this.enabled = diagnosticOptions.enabled;
      this.state = {
        version: DIAGNOSTIC_VERSION,
        resolvedDestination: safeDestinationForDiagnostics(destination),
        selectedMode: modeSelection.name,
        opticalEngine: "uninitialized",
        opticalPaint: "pending",
        movement: "idle",
        movementsReached: [],
        emergencyFallback: false,
        emergencyReason: null,
        blackConfirmed: false,
        markerWritten: false,
        cleanupComplete: false,
        navigationRequested: false
      };

      if (this.enabled) {
        window.__THRESHOLD_DIAGNOSTICS__ = this.state;
        this.publish();
      }
    }

    update(values) {
      if (!this.enabled) {
        return;
      }

      Object.assign(this.state, values);
      this.publish();
    }

    reachMovement(movement) {
      if (!this.enabled || this.state.movement === movement) {
        return;
      }

      this.state.movement = movement;
      const reachedIndex = MOVEMENT_ORDER.indexOf(movement);

      if (reachedIndex >= 0) {
        MOVEMENT_ORDER.slice(0, reachedIndex + 1).forEach((reachedMovement) => {
          if (!this.state.movementsReached.includes(reachedMovement)) {
            this.state.movementsReached.push(reachedMovement);
          }
        });
      } else if (!this.state.movementsReached.includes(movement)) {
        this.state.movementsReached.push(movement);
      }
      this.publish();
    }

    publish() {
      if (!this.enabled) {
        return;
      }

      try {
        window.sessionStorage.setItem(DIAGNOSTIC_STORAGE_KEY, JSON.stringify(this.state));
      } catch {
        // Diagnostics remain available in memory when storage is unavailable.
      }

      window.dispatchEvent(new CustomEvent("threshold:diagnostic", {
        detail: { ...this.state, movementsReached: [...this.state.movementsReached] }
      }));
    }
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
      return true;
    } catch {
      return false;
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

  function computedStyleReferences(computedValue, identifier) {
    return (
      typeof computedValue === "string" &&
      computedValue !== "none" &&
      computedValue.includes(identifier)
    );
  }

  function verifyLiveOpticalPaint(resources) {
    if (
      diagnosticOptions.forcePaintFailure ||
      resources.engine !== "svg-pending" ||
      !resources.svg?.isConnected ||
      !resources.paintProbe?.isConnected
    ) {
      return false;
    }

    const probeBounds = resources.paintProbe.getBoundingClientRect();
    if (probeBounds.width <= 0 || probeBounds.height <= 0) {
      return false;
    }

    const filtersAreLive = resources.expectedFilters.every(({ target, id }) => {
      if (!target?.isConnected || !document.getElementById(id)) {
        return false;
      }

      if (target !== resources.paintProbe) {
        const bounds = target.getBoundingClientRect();
        if (bounds.width < window.innerWidth * 0.98 || bounds.height < window.innerHeight * 0.98) {
          return false;
        }
      }

      return computedStyleReferences(window.getComputedStyle(target).filter, id);
    });

    if (!filtersAreLive || resources.expectedMasks.length === 0) {
      return false;
    }

    const masksAreLive = resources.expectedMasks.every(({ target, id }) => {
      const maskStyles = window.getComputedStyle(target);
      const maskValue = maskStyles.maskImage || maskStyles.webkitMaskImage || "";
      return document.getElementById(id) && computedStyleReferences(maskValue, id);
    });

    return masksAreLive;
  }

  function verifyActiveOpticalContract(resources) {
    if (resources.engine !== "svg") {
      return true;
    }

    return resources.expectedFilters.slice(0, 3).every(({ target, id }) => (
      target?.isConnected &&
      document.getElementById(id) &&
      computedStyleReferences(window.getComputedStyle(target).filter, id)
    ));
  }

  class ThresholdController {
    constructor(link, destination, origin, modeSelection) {
      this.link = link;
      this.destination = destination;
      this.origin = origin;
      this.mode = modeSelection.name;
      this.modeSelection = modeSelection;
      this.resources = null;
      this.diagnostics = new ThresholdDiagnostics(destination, modeSelection);
      this.startTime = 0;
      this.frameRequest = 0;
      this.safetyTimer = 0;
      this.frameCount = 0;
      this.scrollX = window.scrollX;
      this.scrollY = window.scrollY;
      this.currentMovement = "idle";
      this.lastPaintContractMovement = null;
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
      this.diagnostics.update({
        opticalEngine: this.resources.engine,
        opticalPaint: this.resources.engine === "svg-pending" ? "pending" : "not-required",
        reconstruction: {
          visibleFragments: this.resources.stats.visibleFragments,
          clonedElements: this.resources.stats.clonedElements,
          prunedElements: this.resources.stats.prunedElements
        },
        renderingBudget: { ...this.resources.budget }
      });
    }

    begin() {
      if (!this.resources?.system?.isConnected) {
        throw new Error("The optical reconstruction was not attached.");
      }

      this.running = true;
      this.startTime = performance.now();
      this.lockInteraction();
      this.applyState(computeTimelineState(0, this.resources.configuration.timeline));
      this.frameRequest = scheduleFrame(this.tick);
      this.safetyTimer = window.setTimeout(() => {
        this.completeImmediately("safety-timeout");
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
        this.completeImmediately("escape", { emergencyFallback: false });
        return;
      }

      if (SCROLL_KEYS.has(event.key)) {
        event.preventDefault();
      }
    }

    handleVisibilityChange() {
      if (document.hidden && this.running && !this.navigationRequested) {
        this.completeImmediately("visibility-change");
      }
    }

    handlePageHide() {
      this.dispose({ restoreScroll: false });
    }

    applyFragmentRefraction(state) {
      if (!this.resources) {
        return;
      }

      const engineMultiplier = this.resources.engine === "svg" ? 0.32 : 1;
      const configuration = this.resources.configuration;

      this.resources.transformTargets.forEach((target, index) => {
        let amount = configuration.domDisplacement * state.refraction * engineMultiplier;

        if (target.kind === "origin") {
          amount = configuration.originShift * state.origin;
        } else if (target.kind === "language") {
          amount *= 0.34;
        } else if (target.kind === "rules") {
          amount *= 0.52;
        } else if (target.kind === "conduction") {
          amount *= 0.72;
        }

        const alternating = index % 2 === 0 ? 1 : -1;
        const translateX = target.directionX * amount + (alternating * amount * 0.18);
        const translateY = target.directionY * amount - (alternating * amount * 0.12);
        const stretch = 1 + (state.refraction * 0.0025 * alternating * engineMultiplier);
        target.element.style.transform = `translate3d(${translateX.toFixed(3)}px, ${translateY.toFixed(3)}px, 0) scaleX(${stretch.toFixed(5)})`;
      });
    }

    applyState(state) {
      if (!this.resources?.system) {
        return;
      }

      const { system, configuration } = this.resources;
      const reducedMultiplier = this.mode === "reduced" ? 0.72 : 1;
      const languageBrightness = 1 + (state.light * (this.mode === "reduced" ? 0.14 : 0.3));
      const ruleBrightness = 1 + (state.light * (this.mode === "reduced" ? 0.1 : 0.22));
      const materialBrightness = state.release > 0
        ? clamp(state.materialLuminance)
        : 1 + (state.density * 0.055);

      system.style.setProperty("--threshold-origin-presence", clamp(state.origin).toFixed(4));
      system.style.setProperty("--threshold-origin-brightness", (1 + (state.origin * 0.2)).toFixed(4));
      system.style.setProperty("--threshold-language-presence", clamp(state.language * reducedMultiplier).toFixed(4));
      system.style.setProperty("--threshold-conduction-presence", clamp(state.conduction * reducedMultiplier).toFixed(4));
      system.style.setProperty("--threshold-material-presence", clamp(state.material).toFixed(4));
      system.style.setProperty("--threshold-language-brightness", languageBrightness.toFixed(4));
      system.style.setProperty("--threshold-rule-brightness", ruleBrightness.toFixed(4));
      system.style.setProperty("--threshold-material-brightness", materialBrightness.toFixed(4));
      system.style.setProperty("--threshold-density-contrast", (1 + (state.density * 0.045)).toFixed(4));
      system.style.setProperty("--threshold-black-opacity", clamp(state.black).toFixed(4));

      this.applyFragmentRefraction(state);

      if (state.movement !== this.currentMovement) {
        this.currentMovement = state.movement;
        system.dataset.movement = state.movement;
        this.diagnostics.reachMovement(state.movement);
      }

      if (!this.opticsRemoved) {
        this.resources.primaryDisplacement?.setAttribute(
          "scale",
          (configuration.primaryDisplacement * state.refraction).toFixed(3)
        );
        this.resources.localizedDisplacement?.setAttribute(
          "scale",
          (configuration.localizedDisplacement * state.refraction).toFixed(3)
        );
        this.resources.languageDisplacement?.setAttribute(
          "scale",
          (configuration.languageDisplacement * state.refraction).toFixed(3)
        );
      }
    }

    verifyPaintIfReady() {
      if (this.resources?.engine !== "svg-pending" || this.frameCount < 3) {
        return;
      }

      if (verifyLiveOpticalPaint(this.resources)) {
        this.resources.engine = "svg";
        this.resources.system.dataset.optics = "svg";
        this.resources.paintProbe?.remove();
        this.resources.paintProbe = null;
        this.diagnostics.update({ opticalEngine: "svg", opticalPaint: "success" });
        return;
      }

      this.activateDomFallback("paint-verification-failed");
    }

    monitorPaintContract() {
      if (
        this.resources?.engine !== "svg" ||
        this.lastPaintContractMovement === this.currentMovement ||
        !["localization", "presence"].includes(this.currentMovement)
      ) {
        return;
      }

      this.lastPaintContractMovement = this.currentMovement;
      if (!verifyActiveOpticalContract(this.resources)) {
        this.activateDomFallback("runtime-paint-contract-lost");
      }
    }

    activateDomFallback(reason) {
      if (!this.resources?.system || this.resources.engine === "dom") {
        return;
      }

      this.resources.engine = "dom";
      this.resources.system.dataset.optics = "dom";
      this.resources.paintProbe?.remove();
      this.resources.paintProbe = null;
      this.resources.svg?.remove();
      this.resources.svg = null;
      this.resources.primaryDisplacement = null;
      this.resources.localizedDisplacement = null;
      this.resources.languageDisplacement = null;

      if (this.mode === "full") {
        this.mode = "lightweight";
        this.resources.configuration = MODE_CONFIG.lightweight;
        this.resources.system.dataset.mode = "lightweight";
        window.clearTimeout(this.safetyTimer);
        this.safetyTimer = window.setTimeout(() => {
          this.completeImmediately("safety-timeout");
        }, this.resources.configuration.safetyDelay);
      }

      const fallbackIsUsable = (
        this.resources.materialLayer?.isConnected &&
        this.resources.languageLayer?.isConnected &&
        this.resources.transformTargets.length > 0
      );

      this.diagnostics.update({
        selectedMode: this.mode,
        opticalEngine: "dom",
        opticalPaint: "failure",
        fallbackReason: reason
      });

      if (!fallbackIsUsable) {
        this.completeImmediately("dom-fallback-unavailable");
      }
    }

    tick(timestamp) {
      if (!this.running || this.disposed || this.navigationRequested) {
        return;
      }

      this.frameRequest = 0;
      this.frameCount += 1;

      try {
        const elapsed = this.emergency
          ? this.resources.configuration.timeline[4]
          : Math.max(0, timestamp - this.startTime);
        const state = this.emergency
          ? {
              movement: "silence",
              origin: 0,
              language: 0,
              conduction: 0,
              material: 1,
              light: 0,
              refraction: 0,
              density: 0,
              release: 1,
              materialLuminance: 0,
              black: 1
            }
          : computeTimelineState(elapsed, this.resources.configuration.timeline);

        this.applyState(state);
        this.verifyPaintIfReady();
        this.monitorPaintContract();

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

        this.frameRequest = scheduleFrame(this.tick);
      } catch {
        this.completeImmediately("runtime-error");
      }
    }

    confirmPaintedBlack() {
      this.blackPainted = true;
      this.blackAt = Date.now();
      const markerWritten = storeEntryMarker(this.mode, this.blackAt);
      this.diagnostics.update({ blackConfirmed: true, markerWritten });
      this.removeOpticalResources();
    }

    removeOpticalResources() {
      if (this.opticsRemoved || !this.resources) {
        return;
      }

      cancelAnimationsWithin(this.resources.optical);
      this.resources.optical?.remove();
      this.resources.budgetSurface?.remove();
      this.resources.svg?.remove();
      this.resources.paintProbe?.remove();
      this.resources.optical = null;
      this.resources.budgetSurface = null;
      this.resources.svg = null;
      this.resources.paintProbe = null;
      this.resources.primaryDisplacement = null;
      this.resources.localizedDisplacement = null;
      this.resources.languageDisplacement = null;
      this.resources.expectedFilters = [];
      this.resources.expectedMasks = [];
      this.resources.transformTargets = [];
      this.opticsRemoved = true;
    }

    completeImmediately(reason = "emergency", { emergencyFallback = true } = {}) {
      if (this.disposed || this.navigationRequested) {
        return;
      }

      this.emergency = true;
      this.running = true;
      this.blackFrames = 0;
      this.diagnostics.update({
        emergencyFallback,
        emergencyReason: reason,
        accelerated: !emergencyFallback
      });

      try {
        this.applyState({
          movement: "silence",
          origin: 0,
          language: 0,
          conduction: 0,
          material: 1,
          light: 0,
          refraction: 0,
          density: 0,
          release: 1,
          materialLuminance: 0,
          black: 1
        });
      } catch {
        this.resources?.system?.style.setProperty("--threshold-black-opacity", "1");
      }

      if (!this.frameRequest) {
        this.frameRequest = scheduleFrame(this.tick);
      }
    }

    navigate() {
      if (this.navigationRequested || !this.blackPainted) {
        return;
      }

      this.navigationRequested = true;
      this.resources.system.dataset.movement = "arrival";
      this.diagnostics.reachMovement("arrival");
      this.diagnostics.update({ navigationRequested: true });
      cancelFrame(this.frameRequest);
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
        this.diagnostics.update({ navigationRequested: false, navigationFailure: true });
        this.dispose();
      }
    }

    dispose({ restoreScroll = true } = {}) {
      if (this.disposed) {
        return;
      }

      this.disposed = true;
      this.running = false;
      cancelFrame(this.frameRequest);
      window.clearTimeout(this.safetyTimer);
      this.frameRequest = 0;
      this.safetyTimer = 0;
      this.unlockInteraction({ restoreScroll });
      cancelAnimationsWithin(this.resources?.system);
      this.resources?.system?.remove();
      this.resources = null;
      this.diagnostics.update({ cleanupComplete: true });

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
    stabilizeEntryLinks();
  }

  function startTransition(event, link) {
    let destination;

    try {
      destination = resolveEntryDestination(link);
      link.href = destination.href;
    } catch {
      return;
    }

    if (!isStandardActivation(event, link, destination)) {
      return;
    }

    if (activeTransition) {
      event.preventDefault();
      return;
    }

    const modeSelection = selectExecutionMode();
    const origin = getOrigin(event, link);
    const controller = new ThresholdController(link, destination.href, origin, modeSelection);

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
      controller.completeImmediately("initialization-error");
    }
  }

  if (!diagnosticOptions.enabled) {
    try {
      window.sessionStorage.removeItem(DIAGNOSTIC_STORAGE_KEY);
    } catch {
      // Diagnostics are optional and never affect the real link.
    }
  }

  stabilizeEntryLinks();

  document.addEventListener("pointerdown", (event) => {
    if (
      event.isPrimary === false ||
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
