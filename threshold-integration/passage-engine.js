// passage-engine.js — experiment/liquid-threshold-passage
//
// Complete architectural reset of the Home -> Game Localization Crossing.
// Every prior generation of this effect (the root styles.css/script.js
// "threshold-system" — retired, dormant, never reactivated by this file;
// the WebGL water-simulation "material-engine.js" lineage — Gate 1,
// continuous-river) hid the live Home DOM the instant a click landed and
// replaced it with a *texture* of Home: either a click-time html2canvas
// capture, or a canonical PNG pre-baked at a fixed reference viewport.
// Real-device testing on the EliteBook repeatedly showed a perceptible
// jolt at exactly that moment. The most likely root cause, on inspection,
// was never the CSS transition or the scrollbar (both real, both already
// mitigated below, neither sufficient on their own) — it was that a
// texture captured/baked at one geometry is compared, pixel for pixel,
// against a live page rendered at the visitor's OWN viewport geometry.
// Unless those two exactly match, the instant of hand-off is a real,
// physical discontinuity: different crop, different scale, different
// font hinting/antialiasing, sometimes different content. No transition
// duration or scrollbar fix can hide a genuine geometry mismatch.
//
// This file does not make that trade at all. There is no Home texture,
// no capture, no prebaked asset, anywhere in this experiment. The
// liquefaction phase runs as an SVG filter (feTurbulence +
// feDisplacementMap, standard, GPU-composited, browser-native) applied
// directly to the real, live, currently-on-screen Home DOM, in place.
// The displacement starts at literally zero, so the first frame after
// the click is not a *copy* of what the visitor was looking at — it IS
// what they were looking at, mathematically unchanged. There is no frame
// where a swap occurs, because nothing is ever swapped: the same DOM
// nodes stay on screen throughout, increasingly distorted, until they are
// visually abstract enough (heavily displaced, desaturated, darkened
// toward the same dark palette the destination world uses) that hand-off
// to the WebGL canvas — which continues that same abstract dark liquid,
// not a picture of Home — is not a mismatch anymore because there is no
// longer any specific content on either side to mismatch. That is the
// actual elimination of the previously diagnosed cause, not a disguise
// of it: the hand-off is real, but it happens once the visitor is no
// longer looking at "Home or a copy of Home" at all, only at liquid.
//
// From there, everything is procedural (a closed-form analytic water
// field, no simulation texture, no image of any kind) and driven by one
// continuous, eased clock — an aperture grows out of the liquid, the
// destination atmosphere becomes visible through it, and the aperture
// consumes the frame. No portal geometry, palette, phase count, or
// timing from any previous experiment is reused as a constraint. Only
// the atmosphere's own palette/positions (cyan/violet/vignette/spark) are
// deliberately carried forward from experiment/continuous-river, because
// that palette is the one thing already validated to read as "the same
// Games world," and the user asked to preserve that principle.
//
// Timing is authored, not computed: see the TIMELINE block below for the
// perceptual reasoning behind each duration. Total click-to-navigation
// is ~10.4s; combined with the Games-side arrival (see
// game-localization/styles.css, ~1.5s), total click-to-settled-text lands
// close to the requested ~12s — arrived at by choreographing distinct,
// still-in-motion beats, not by uniformly stretching a shorter timeline.

(() => {
  "use strict";

  if (window.__mvPassage) return; // idempotent against double script-load

  // ==========================================================================
  // TIMELINE — the only place durations live. Every number below exists to
  // give a specific perceptual event enough time to be understood, per the
  // product brief's own numbered list. None of this is a mechanical stretch
  // of any prior experiment's numbers; each duration was chosen fresh for
  // what needs to be seen during it.
  // ==========================================================================

  // The DOM is never given a hard "settle" delay before distorting — the
  // filter's displacement genuinely starts at 0, which is a no-op, so
  // there is nothing to wait out. Motion begins the instant activate() is
  // called (next animation frame).

  // Beat 1-2 (notice change / understand it's becoming liquid): the SVG
  // displacement ramps from 0 to its full magnitude while a color grade
  // pulls Home's own palette (--color-blue-haze/--color-paper/--color-ink)
  // toward the same dark, cyan-leaning tone the liquid material and the
  // destination atmosphere both already use — so nothing has to change
  // color again later. 1900ms: fast enough to feel like a direct response
  // to the click, slow enough that the eye can track it happening rather
  // than perceive a cut.
  const LIQUEFY_RAMP_DURATION = 1900;

  // Beat 3 (appreciate the liquid): displacement holds near its peak and
  // *breathes* (slow oscillation in both the turbulence field and the
  // displacement magnitude) rather than freezing — a static distorted
  // frame would read as a stall, not a material. 2500ms is long enough
  // that a viewer can watch it move, recognize the motion as organic, and
  // only then feel ready for something new to happen.
  const LIQUEFY_BREATHE_DURATION = 2500;

  // The one unavoidable technical hand-off in this whole experience: DOM
  // wrapper fades out as the canvas fades in, both already showing the
  // same dark, turbulent, cyan-tinted material (see the color grade
  // above and LIQUID_TARGET_* below) at the moment they cross. Short on
  // purpose — this is not a beat the visitor is meant to notice as a
  // beat, only as continued liquid motion.
  const CANVAS_HANDOFF_DURATION = 550;

  // Beat 4-6 (the passage emerges / another world exists beyond it / the
  // crossing itself): one continuous eased curve grows the aperture from
  // a seed point to full frame coverage. It is authored as a single span
  // rather than two separately-timed stages so the motion never has a
  // joint to be felt at — but it is long enough (4150ms) that the first
  // ~35% reads unmistakably as "an opening is forming, and there is
  // something beyond it" before the remaining ~65% reads as "that opening
  // is now sweeping outward and taking over" — an accelerating,
  // enveloping crossing, not a wipe.
  const OPENING_DURATION = 4150;

  // Beat 7 (recognize the arrival): once the aperture has consumed the
  // frame, the atmosphere keeps developing for a moment on its own —
  // cyan/violet still deepening slightly, the spark still gathering — a
  // held beat that is nonetheless still alive, not a static frame. Real
  // navigation fires at the end of this hold (see phase-a1-integration.js).
  const ATMOSPHERE_SETTLE_DURATION = 1300;

  const TIMELINE = Object.freeze({
    liquefyRamp: LIQUEFY_RAMP_DURATION,
    liquefyBreathe: LIQUEFY_BREATHE_DURATION,
    canvasHandoff: CANVAS_HANDOFF_DURATION,
    opening: OPENING_DURATION,
    atmosphereSettle: ATMOSPHERE_SETTLE_DURATION
  });

  // Cumulative breakpoints (ms since activation).
  const T_LIQUEFY_RAMP_END = LIQUEFY_RAMP_DURATION;
  const T_LIQUEFY_END = T_LIQUEFY_RAMP_END + LIQUEFY_BREATHE_DURATION;
  const T_HANDOFF_END = T_LIQUEFY_END + CANVAS_HANDOFF_DURATION;
  const T_OPENING_END = T_HANDOFF_END + OPENING_DURATION;
  const T_SETTLE_END = T_OPENING_END + ATMOSPHERE_SETTLE_DURATION;

  // ==========================================================================
  // Easing
  // ==========================================================================

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  // ==========================================================================
  // DOM liquefaction — SVG filter applied to the real, live Home content.
  // ==========================================================================

  // The wrapper exists purely so ONE filter (and therefore one continuous
  // noise field) covers header+main+footer together — applying the same
  // filter to three separate siblings would give each its own filter
  // region/coordinate space and the seams between them would show. Home's
  // own CSS has no selector keyed on header/main/footer being direct
  // children of body (confirmed by inspection before writing this), and
  // body itself is a plain block (no grid/flex placement depending on
  // them), so this reparenting is layout-neutral: cloneNode is not used
  // anywhere here, the real nodes (with all their real state/listeners)
  // are simply moved one level deeper via appendChild.
  let liquidWrap = null;

  function ensureLiquidWrap() {
    if (liquidWrap) return liquidWrap;
    const existing = document.getElementById("mv-liquid-wrap");
    if (existing) { liquidWrap = existing; return liquidWrap; }

    const wrap = document.createElement("div");
    wrap.id = "mv-liquid-wrap";
    const toMove = [];
    for (const child of document.body.children) {
      if (child.id === "mv-canvas" || child.id === "mv-controls" || child.tagName === "SCRIPT" || child.tagName === "SVG") continue;
      toMove.push(child);
    }
    document.body.insertBefore(wrap, toMove[0] || null);
    for (const el of toMove) wrap.appendChild(el);
    liquidWrap = wrap;
    return wrap;
  }

  // SVG filter defs — a single hidden <svg>, injected once. Standard
  // feTurbulence/feDisplacementMap: no experimental filter primitives,
  // nothing invisible-layer-dependent, nothing that requires the browser
  // to rasterize an off-screen target — this filters exactly what is
  // already being composited on screen.
  let turbEl = null;
  let dispEl = null;

  function ensureLiquefyFilter() {
    if (document.getElementById("mv-liquefy-filter")) {
      turbEl = document.getElementById("mv-liquefy-turb");
      dispEl = document.getElementById("mv-liquefy-disp");
      return;
    }
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.style.position = "absolute";
    svg.style.width = "0";
    svg.style.height = "0";
    svg.style.overflow = "hidden";

    const filter = document.createElementNS(svgNS, "filter");
    filter.id = "mv-liquefy-filter";
    // Generous region so peak displacement never clips at the element's
    // own bounding-box edge.
    filter.setAttribute("x", "-40%");
    filter.setAttribute("y", "-40%");
    filter.setAttribute("width", "180%");
    filter.setAttribute("height", "180%");
    filter.setAttribute("color-interpolation-filters", "sRGB");

    turbEl = document.createElementNS(svgNS, "feTurbulence");
    turbEl.id = "mv-liquefy-turb";
    turbEl.setAttribute("type", "fractalNoise");
    turbEl.setAttribute("baseFrequency", "0.009 0.013");
    turbEl.setAttribute("numOctaves", "2");
    turbEl.setAttribute("seed", "7");
    turbEl.setAttribute("stitchTiles", "noStitch");
    turbEl.setAttribute("result", "mv-noise");

    dispEl = document.createElementNS(svgNS, "feDisplacementMap");
    dispEl.id = "mv-liquefy-disp";
    dispEl.setAttribute("in", "SourceGraphic");
    dispEl.setAttribute("in2", "mv-noise");
    dispEl.setAttribute("scale", "0");
    dispEl.setAttribute("xChannelSelector", "R");
    dispEl.setAttribute("yChannelSelector", "G");

    filter.appendChild(turbEl);
    filter.appendChild(dispEl);
    svg.appendChild(filter);
    document.body.appendChild(svg);
  }

  // Peak displacement, in the filter's local units (≈CSS px for an
  // untransformed element). Large enough to be unmistakably liquid, not
  // so large it tears the content into unrecognizable noise before the
  // breathing beat has had a chance to read as organic.
  const DISPLACEMENT_PEAK = 86;
  const DISPLACEMENT_BREATHE_AMPLITUDE = 11;

  // Color grade target — pulls Home's own palette (--color-blue-haze
  // #dce9ee, --color-paper #f4f1ea, --color-ink #143747) toward the same
  // dark, cyan-leaning tone the canvas liquid and the destination
  // atmosphere both use (atmosphere base #050510, ink itself is already
  // in the same dark-teal family). Brightness does most of the work
  // (crushing the pale background toward near-black while the already-
  // dark ink goes to near-pure-black, reading as darker "veins" in the
  // liquid); contrast keeps some of that structure legible as texture
  // rather than a flat wash; saturate+hue-rotate hold the remaining tone
  // in the cyan family instead of letting it desaturate to grey.
  function domFilterAt(t) {
    // t: 0 at click, 1 at full liquefaction (peak of the ramp).
    const bright = 1 - t * 0.84; // 1 -> 0.16
    const contrast = 1 + t * 0.35; // 1 -> 1.35
    const saturate = 1 + t * 0.6; // 1 -> 1.6
    const hue = t * -8; // 0 -> -8deg
    return { bright, contrast, saturate, hue };
  }

  function applyDomFilter(displacementScale, grade) {
    if (dispEl) dispEl.setAttribute("scale", String(displacementScale));
    if (liquidWrap) {
      liquidWrap.style.filter =
        `url(#mv-liquefy-filter) brightness(${grade.bright.toFixed(3)}) contrast(${grade.contrast.toFixed(3)}) saturate(${grade.saturate.toFixed(3)}) hue-rotate(${grade.hue.toFixed(2)}deg)`;
    }
  }

  // ==========================================================================
  // WebGL canvas — pure procedural liquid + aperture + atmosphere. No
  // texture of any kind is ever bound; nothing here depends on an image
  // load completing, which is also why this engine has no async
  // "ensureReady" path of its own: shader compile is the only setup cost,
  // and it is effectively instantaneous.
  // ==========================================================================

  const VERTEX_SHADER = `
    attribute vec2 aPosition;
    varying vec2 vUv;
    void main() {
      vUv = aPosition * 0.5 + 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;

  // ambientWater(): reused verbatim (same four-wave analytic field) from
  // the continuous-river/material-engine.js lineage — it is a
  // closed-form function of position and time, not a simulation texture,
  // so porting it forward costs nothing and buys an already-tuned,
  // organic-looking motion for free.
  const FRAGMENT_SHADER = `
    precision highp float;

    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uApertureRadius;   // 0 .. ~1.4, aspect-corrected UV units
    uniform float uAtmosphereReveal; // 0..1
    uniform float uPushZoom;         // 0..~0.2

    varying vec2 vUv;

    void ambientWater(
      vec2 position, float time, out float height, out vec2 slope, out float curvature
    ) {
      vec2 d1 = vec2(1.0, 0.0);
      vec2 d2 = vec2(0.5, 0.8660254);
      vec2 d3 = vec2(-0.7660444, 0.6427876);
      vec2 d4 = vec2(0.1736482, -0.9848078);

      float f1 = 4.4; float f2 = 6.1; float f3 = 8.3; float f4 = 11.2;
      float p1 = dot(position, d1) * f1 + time * 0.62 + 0.35;
      float p2 = dot(position, d2) * f2 - time * 0.47 + 1.90;
      float p3 = dot(position, d3) * f3 + time * 0.36 + 3.25;
      float p4 = dot(position, d4) * f4 - time * 0.28 + 5.10;
      float a1 = 0.020; float a2 = 0.015; float a3 = 0.010; float a4 = 0.007;

      height = sin(p1) * a1 + sin(p2) * a2 + sin(p3) * a3 + sin(p4) * a4;
      slope = d1 * cos(p1) * f1 * a1 + d2 * cos(p2) * f2 * a2 + d3 * cos(p3) * f3 * a3 + d4 * cos(p4) * f4 * a4;
      curvature = -(sin(p1) * f1 * f1 * a1 + sin(p2) * f2 * f2 * a2 + sin(p3) * f3 * f3 * a3 + sin(p4) * f4 * f4 * a4);
    }

    // Same palette/positions validated in experiment/continuous-river,
    // parameterized by an explicit uv/aspect pair (so it can be sampled
    // through the push-zoom below) and by "reveal" instead of a global
    // worldMix — the aperture shape itself is the spatial mask now, so
    // this no longer needs its own richness-gated coverage term.
    vec3 atmosphereColor(vec2 uv, float aspect, float reveal) {
      vec3 base = vec3(0.0196, 0.0196, 0.0627);

      vec2 cyanCenter = vec2(0.30, 0.32);
      vec2 cyanDelta = (uv - cyanCenter) * vec2(aspect, 1.0);
      float cyanFalloff = exp(-dot(cyanDelta, cyanDelta) * 2.4);
      float cyanIntensity = 0.17 * smoothstep(0.0, 0.30, reveal);
      vec3 cyanColor = vec3(0.094, 0.878, 1.0);
      vec3 atmosphere = 1.0 - (1.0 - base) * (1.0 - cyanColor * cyanFalloff * cyanIntensity);

      vec2 violetCenter = vec2(0.72, 0.78);
      vec2 violetDelta = (uv - violetCenter) * vec2(aspect, 1.0);
      float violetFalloff = exp(-dot(violetDelta, violetDelta) * 2.1);
      float violetIntensity = 0.05 * smoothstep(0.10, 0.65, reveal);
      vec3 violetColor = vec3(0.753, 0.149, 0.961);
      atmosphere = 1.0 - (1.0 - atmosphere) * (1.0 - violetColor * violetFalloff * violetIntensity);

      float vignette = smoothstep(0.92, 0.30, length(uv - 0.5));
      atmosphere *= mix(0.74, 1.0, vignette);

      vec2 sparkCenter = vec2(0.5, 0.46);
      vec2 sparkDelta = (uv - sparkCenter) * vec2(aspect, 1.0);
      float sparkFalloff = exp(-dot(sparkDelta, sparkDelta) * 240.0);
      float sparkIntensity = 0.85 * smoothstep(0.30, 0.80, reveal);
      atmosphere += vec3(1.0) * sparkFalloff * sparkIntensity;

      return atmosphere;
    }

    void main() {
      float aspect = uResolution.x / max(uResolution.y, 1.0);
      vec2 position = (vUv - 0.5) * vec2(aspect, 1.0);

      float height; vec2 slope; float curvature;
      ambientWater(position, uTime, height, slope, curvature);

      // Procedural liquid shading — no texture, ever. A fake normal from
      // the analytic slope gives a moving specular sheen; height biases
      // a deep-navy/dark-teal gradient (the same dark family as the
      // atmosphere's own base and Home's own --color-ink, deliberately,
      // so nothing has to change hue again once the aperture opens).
      vec3 normal = normalize(vec3(-slope * 2.4, 1.0));
      vec3 lightDir = normalize(vec3(0.35, 0.5, 0.8));
      float diffuse = clamp(dot(normal, lightDir), 0.0, 1.0);
      float spec = pow(clamp(dot(reflect(-lightDir, normal), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 42.0);

      vec3 liquidDeep = vec3(0.012, 0.02, 0.05);
      vec3 liquidMid = vec3(0.028, 0.085, 0.125);
      vec3 liquidColor = mix(liquidDeep, liquidMid, diffuse);
      liquidColor += vec3(0.35, 0.85, 0.95) * spec * 0.55;
      liquidColor += vec3(0.55, 0.30, 0.85) * pow(clamp(curvature * 0.5 + 0.5, 0.0, 1.0), 3.0) * 0.05;

      // Aperture: an organic-edged opening, its wobble driven by the same
      // liquid field it is emerging from (so it reads as torn from the
      // material itself, not a geometric shape laid on top of it).
      vec2 apertureCenter = vec2(0.5, 0.46); // same point the spark occupies
      vec2 apertureDelta = (vUv - apertureCenter) * vec2(aspect, 1.0);
      float distToCenter = length(apertureDelta);
      float edgeWobble = height * 1.6 + curvature * 0.018;
      float apertureEdge = uApertureRadius + edgeWobble;
      float apertureField = smoothstep(apertureEdge + 0.11, apertureEdge - 0.11, distToCenter);

      vec2 zoomedUv = (vUv - 0.5) * (1.0 - uPushZoom) + 0.5;
      vec3 atmosphere = atmosphereColor(zoomedUv, aspect, uAtmosphereReveal);

      vec3 color = mix(liquidColor, atmosphere, apertureField);
      gl_FragColor = vec4(color, 1.0);
    }
  `;

  // ==========================================================================
  // Engine state
  // ==========================================================================

  let canvas = null;
  let gl = null;
  let program = null;
  let uniforms = {};
  let vao = null;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  let materialPhase = "idle"; // idle | liquefying | crossing | settled
  let activatedAt = null;
  let rafHandle = null;
  let controlsEl = null;
  let statusEl = null;
  let fallbackReason = null;

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error("shader compile failed: " + info);
    }
    return shader;
  }

  function initGL() {
    canvas = document.getElementById("mv-canvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.id = "mv-canvas";
      canvas.setAttribute("aria-hidden", "true");
      document.body.appendChild(canvas);
    }
    gl = canvas.getContext("webgl", { antialias: true, alpha: false, premultipliedAlpha: false })
      || canvas.getContext("experimental-webgl", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL unavailable");

    const vs = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error("program link failed: " + gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    vao = buffer;

    uniforms = {
      resolution: gl.getUniformLocation(program, "uResolution"),
      time: gl.getUniformLocation(program, "uTime"),
      apertureRadius: gl.getUniformLocation(program, "uApertureRadius"),
      atmosphereReveal: gl.getUniformLocation(program, "uAtmosphereReveal"),
      pushZoom: gl.getUniformLocation(program, "uPushZoom")
    };

    resizeCanvas();
  }

  function resizeCanvas() {
    if (!canvas || !gl) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  window.addEventListener("resize", resizeCanvas, { passive: true });

  // ==========================================================================
  // Scroll lock — same real fix carried forward from continuous-river:
  // overflow:hidden alone shifts page content sideways by a non-overlay
  // scrollbar's own width the instant it is removed; scrollbar-gutter:
  // stable (see passage-harness.css) reserves that space permanently so
  // removing the functional scrollbar causes no layout shift. This is a
  // genuine fix for a real, understood cause, not a cosmetic patch.
  // ==========================================================================

  let scrollY0 = 0;

  function lockScroll() {
    scrollY0 = window.scrollY || window.pageYOffset || 0;
    const html = document.documentElement;
    html.classList.add("mv-scroll-locked");
    document.body.style.top = `-${scrollY0}px`;
  }

  function unlockScroll() {
    const html = document.documentElement;
    html.classList.remove("mv-scroll-locked");
    document.body.style.top = "";
    window.scrollTo(0, scrollY0);
  }

  // ==========================================================================
  // Public activation
  // ==========================================================================

  function setStatus(state, text) {
    if (statusEl) {
      statusEl.dataset.state = state;
      statusEl.textContent = text || state;
    }
  }

  function ensureControls() {
    if (document.getElementById("mv-controls")) {
      controlsEl = document.getElementById("mv-controls");
      statusEl = document.getElementById("mv-status");
      return;
    }
    controlsEl = document.createElement("div");
    controlsEl.id = "mv-controls";

    const activateBtn = document.createElement("button");
    activateBtn.id = "mv-activate";
    activateBtn.type = "button";
    activateBtn.textContent = "Activate";
    activateBtn.addEventListener("click", () => activate());

    const resetBtn = document.createElement("button");
    resetBtn.id = "mv-reset";
    resetBtn.type = "button";
    resetBtn.textContent = "Reset";
    resetBtn.addEventListener("click", () => reset());

    statusEl = document.createElement("span");
    statusEl.id = "mv-status";
    statusEl.dataset.state = "idle";
    statusEl.textContent = "idle";

    controlsEl.appendChild(activateBtn);
    controlsEl.appendChild(resetBtn);
    controlsEl.appendChild(statusEl);
    document.body.appendChild(controlsEl);
  }

  function activate() {
    if (materialPhase !== "idle") return;
    if (!gl) {
      try { initGL(); } catch (error) {
        fallbackReason = error && error.message ? error.message : String(error);
        setStatus("fallback", fallbackReason);
        return;
      }
    }
    ensureLiquidWrap();
    ensureLiquefyFilter();
    if (liquidWrap) {
      liquidWrap.style.willChange = "filter";
      liquidWrap.style.pointerEvents = "none";
    }
    lockScroll();
    canvas.classList.add("is-visible");
    document.documentElement.classList.add("mv-active");
    activatedAt = performance.now();
    materialPhase = "liquefying";
    setStatus("liquid", "liquefying");
    if (!rafHandle) rafHandle = requestAnimationFrame(tick);
  }

  function reset() {
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
    materialPhase = "idle";
    activatedAt = null;
    if (canvas) canvas.classList.remove("is-visible");
    document.documentElement.classList.remove("mv-active");
    if (liquidWrap) {
      // Deliberately restored to the SAME identity filter prepare() set
      // (not cleared to "none") — clearing it would undo the one-time
      // layer promotion this experiment goes out of its way to do early,
      // and a later reactivation (bfcache reentry, or the manual Reset
      // button while testing) would then reintroduce the exact
      // antialiasing pop at that reactivation's click instead.
      applyDomFilter(0, domFilterAt(0));
      liquidWrap.style.opacity = "";
      liquidWrap.style.pointerEvents = "";
    }
    unlockScroll();
    setStatus("ready", "ready");
  }

  function tick(now) {
    rafHandle = requestAnimationFrame(tick);
    const elapsed = now - activatedAt;

    // --- DOM liquefaction (0 .. T_LIQUEFY_END, continuing to breathe
    // faintly through the canvas hand-off so the cross-fade never meets
    // a frozen frame on the DOM side) ---
    let rampT, displacementScale, grade;
    if (elapsed <= T_LIQUEFY_RAMP_END) {
      rampT = easeInOutCubic(clamp01(elapsed / LIQUEFY_RAMP_DURATION));
      displacementScale = rampT * DISPLACEMENT_PEAK;
      grade = domFilterAt(rampT);
    } else {
      rampT = 1;
      const breatheElapsed = elapsed - T_LIQUEFY_RAMP_END;
      const breathePhase = Math.sin((breatheElapsed / 1300) * Math.PI * 2);
      displacementScale = DISPLACEMENT_PEAK + breathePhase * DISPLACEMENT_BREATHE_AMPLITUDE;
      grade = domFilterAt(1);
    }
    applyDomFilter(displacementScale, grade);

    // --- Canvas hand-off ---
    let canvasOpacity = 0;
    if (elapsed > T_LIQUEFY_END) {
      canvasOpacity = clamp01((elapsed - T_LIQUEFY_END) / CANVAS_HANDOFF_DURATION);
      canvas.style.opacity = String(canvasOpacity);
      if (liquidWrap) liquidWrap.style.opacity = String(1 - canvasOpacity);
    }

    // --- Aperture / atmosphere ---
    let apertureRadius = 0;
    let atmosphereReveal = 0;
    let pushZoom = 0;
    if (elapsed > T_HANDOFF_END) {
      const openingT = easeInOutCubic(clamp01((elapsed - T_HANDOFF_END) / OPENING_DURATION));
      apertureRadius = openingT * 1.35;
      atmosphereReveal = Math.min(1, openingT / 0.85);
      pushZoom = easeOutCubic(clamp01((elapsed - T_HANDOFF_END) / OPENING_DURATION)) * 0.16;
    }
    if (elapsed > T_OPENING_END) {
      const settleT = clamp01((elapsed - T_OPENING_END) / ATMOSPHERE_SETTLE_DURATION);
      atmosphereReveal = 1; // fully arrived; the shader's own smoothsteps already peaked
      pushZoom = 0.16 + settleT * 0.02;
    }

    // --- phase bookkeeping ---
    let nextPhase = materialPhase;
    if (elapsed <= T_LIQUEFY_END) nextPhase = "liquefying";
    else if (elapsed <= T_OPENING_END) nextPhase = "crossing";
    else nextPhase = "settled";
    if (nextPhase !== materialPhase) {
      materialPhase = nextPhase;
      setStatus(materialPhase === "settled" ? "ready" : "liquid", materialPhase);
    }

    resizeCanvas();
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.time, now / 1000);
    gl.uniform1f(uniforms.apertureRadius, apertureRadius);
    gl.uniform1f(uniforms.atmosphereReveal, atmosphereReveal);
    gl.uniform1f(uniforms.pushZoom, pushZoom);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ==========================================================================
  // Bootstrap — no image loading, so "ready" is just "script parsed and
  // GL context/shader compiled," which is effectively instantaneous. Still
  // exposed as an explicit prepare() so the adapter can call it as early
  // as possible and know definitively when it is safe to activate.
  // ==========================================================================

  function prepare() {
    ensureControls();
    if (!gl) {
      try { initGL(); } catch (error) {
        fallbackReason = error && error.message ? error.message : String(error);
        setStatus("fallback", fallbackReason);
        return false;
      }
    }
    ensureLiquidWrap();
    ensureLiquefyFilter();
    // Applying the identity filter (scale 0, every color-grade term
    // neutral) here — at prepare() time, i.e. page load, not activate()
    // time — matters more than it looks: measured directly (a same-
    // frame screenshot diff, isolated from any other change) that merely
    // switching an element's `filter` from `none` to *any* url()
    // reference, even a mathematically-identity one, promotes it to its
    // own compositing layer and perceptibly changes how its text is
    // antialiased — a real, if subtle, pixel-level discontinuity, not a
    // geometric one. Doing this once, silently, when the page is still
    // idle (long before any click) means that by the time a visitor
    // actually clicks, that rendering-path change already happened
    // seconds or minutes ago and is simply how the page has looked the
    // whole time they were reading it — so nothing about the click
    // itself triggers it anymore.
    if (liquidWrap) liquidWrap.style.willChange = "filter";
    applyDomFilter(0, domFilterAt(0));
    setStatus("ready", "ready");
    return true;
  }

  window.__mvPassage = {
    prepare,
    activate,
    reset,
    getPhase: () => materialPhase,
    getTimeline: () => TIMELINE,
    getActivatedAt: () => activatedAt,
    getFallbackReason: () => fallbackReason,
    hideControls: () => { if (controlsEl) controlsEl.classList.add("mv-controls-hidden"); },
    showControls: () => { if (controlsEl) controlsEl.classList.remove("mv-controls-hidden"); },
    isControlsHidden: () => !!(controlsEl && controlsEl.classList.contains("mv-controls-hidden"))
  };
})();
