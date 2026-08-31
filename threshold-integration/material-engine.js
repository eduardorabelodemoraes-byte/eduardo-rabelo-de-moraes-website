(() => {
  "use strict";

  // ==========================================================================
  // material-validation engine.
  //
  // Material behavior (WATER_SHADER, the ambientWater() function, and the
  // slope/gradient combination + bounded-refraction logic in
  // MATERIAL_SHADER) is reused VERBATIM from the recovered engine at
  // /tmp/laboratory-recovered/laboratory-recovered-water-2026-08-11.js —
  // same stateful ping-pong height/velocity simulation, same fixed-timestep
  // accumulator with capped substeps, same analytic 4-wave ambient field,
  // same slope-derived (not raw-value) bounded refraction. DEFAULTS,
  // LIQUID_ENGAGE_DURATION, SIMULATION_LONG_SIDE/MIN_SIDE,
  // MAX_SIMULATION_STEPS and MOTION_RATE are the recovered engine's own
  // constants, unchanged.
  //
  // The ONLY change inside MATERIAL_SHADER is dropping the recovered
  // engine's second texture-mapping stage (uTextureScale/uTextureOffset),
  // which existed only to crop a padded/oversized capture asset. Our
  // pre-baked textures have no padding, so uHome is sampled directly at
  // the cover-fit frameUv — a single clean texture sample, one mapping
  // stage instead of two, same idea the recovered engine was expressing.
  //
  // Everything else in this file — texture loading, canvas sizing,
  // activation lifecycle, DOM-hide/scroll-lock, controls — is new and
  // deliberately minimal. It does NOT reuse water-engine.js/
  // water-harness.css. There is no HUD, no details panel, no debug-boost
  // uniform, no tier/grid-size switching, no engagement-timing presets.
  // Just Activate, Reset, an A/B/C perceptual-strength selector, and a
  // tiny fps readout.
  //
  // v2 change (perceptual calibration only, per explicit instruction):
  // DEFAULTS.amplitude stays exactly as v1 (4) and still drives the
  // SIMULATION's own impulse strength below (runWaterStep) — that is
  // physics, untouched. A second, independent value — DISPLAY_AMPLITUDE_CSS_PX
  // — drives ONLY the final uAmplitude uniform in draw(), i.e. only the
  // slope->pixel mapping in MATERIAL_SHADER. The shader formula itself
  // (refractionPixels = clamp(boundedSlope*2.25,-1,1) * uAmplitude * liquid)
  // is byte-identical to v1 — nothing added, no new layer. Only the
  // number fed into uAmplitude changes with the selected variant.
  //
  // DPR correction: uResolution in the shader is the canvas's BACKING
  // STORE size in device pixels (canvas.width/height), which v1 already
  // capped at MAX_CANVAS_DPR — so a fixed uAmplitude value does not mean
  // a fixed on-screen (CSS-pixel) displacement across devices whose real
  // devicePixelRatio differs from that cap. Concretely: on a dpr=1
  // desktop, dprCapped=1 and the backing store matches CSS pixels 1:1,
  // so uAmplitude IS the CSS-pixel displacement. On a dpr=3 iPhone,
  // dprCapped is clamped to 2, so the backing store is only 2/3 the
  // device's real pixel density and the browser upscales it — a FIXED
  // uAmplitude value there produces uAmplitude/dprCapped CSS-pixel
  // displacement, i.e. HALF the desktop's result at the same raw number
  // (amplitude 4 -> 4px on desktop but only 2px-equivalent on iPhone).
  // That asymmetry was silent in v1. Here it's corrected by design:
  // uAmplitude = <table>[variant] * dprCapped, so the resulting
  // CSS-pixel-equivalent displacement is the same physical size on both
  // platforms for the same A/B/C label AND the same device class. The
  // exact numbers sent per device are exposed via __mvDebug and stated
  // in the report. This DPR correction is unchanged from v2 — it still
  // applies identically underneath whichever table (below) is active.
  //
  // v3 change (desktop-only amplitude calibration, per explicit
  // instruction — mobile amplitude is unchanged from v2):
  // v1/v2 used ONE DISPLAY_AMPLITUDE_CSS_PX table shared by both device
  // classes, so A/B/C meant the same CSS-px displacement on mobile and
  // desktop. Real-device testing (round-8/round-9 videos) showed that
  // "same CSS-px" does not mean "same perceived liquid presence" —
  // desktop's larger responsive type scale reads the identical
  // displacement as visibly weaker than mobile's smaller type scale
  // does. iPhone A=4 is now fixed as the approved perceptual reference;
  // this pass ONLY searches for which desktop amplitude reads as
  // equivalent to it. So there are now two independent tables, chosen
  // by activeTextureKey (the same "mobile" vs "desktop" signal
  // selectTextureKey() already computed in v1/v2 from
  // window.innerWidth <= 700 — no new device-detection logic was
  // added). DISPLAY_AMPLITUDE_CSS_PX_MOBILE is byte-identical to v2's
  // only table (A=4, B=14, C=28) — mobile behavior is unchanged.
  // DISPLAY_AMPLITUDE_CSS_PX_DESKTOP is new: A stays 4 (the existing
  // baseline the user reported as too subtle on desktop), B and C are
  // raised for desktop-only manual comparison. The A/B/C letters
  // themselves are still a single, manually-operated, non-viewport-
  // reactive selector — only what a given letter maps to numerically now
  // depends on device class, exactly the same kind of per-device mapping
  // the DPR correction above already does.
  // ==========================================================================

  const DEFAULTS = Object.freeze({
    amplitude: 4, // simulation impulse-strength input ONLY — physics, unchanged from v1
    scale: 1,
    viscosity: 0.78,
    speed: 0.2
  });

  // Mobile table: byte-identical to v2's single table. Do not change —
  // this pass's instructions explicitly preserve mobile amplitude as-is.
  const DISPLAY_AMPLITUDE_CSS_PX_MOBILE = Object.freeze({
    A: 4,
    B: 14,
    C: 28
  });

  // Desktop table: new this pass. A is the existing 4px baseline (kept
  // as the floor/reference so it can still be compared directly against
  // B/C). B/C are deliberately a large, round-number spread rather than
  // a small increment — see the delivery report for the reasoning
  // (typographic-ratio estimate vs. the empirical video evidence that
  // desktop A reads much weaker than a naive font-size ratio predicts).
  const DISPLAY_AMPLITUDE_CSS_PX_DESKTOP = Object.freeze({
    A: 4,
    B: 16,
    C: 32
  });

  const VARIANT_ORDER = ["A", "B", "C"];

  // Single source of truth for "which table applies right now" — reuses
  // activeTextureKey, which selectTextureKey()/resizeCanvas() already
  // maintain from window.innerWidth <= 700. Never touches viewport
  // handling itself; only reads its existing result.
  function currentAmplitudeTable() {
    return activeTextureKey === "mobile" ? DISPLAY_AMPLITUDE_CSS_PX_MOBILE : DISPLAY_AMPLITUDE_CSS_PX_DESKTOP;
  }

  const LIQUID_ENGAGE_DURATION = 1050; // ms — recovered engine's own value, unchanged this pass

  // --- Crossing experiment (this pass) additions ---
  // Both durations below are explicitly PROVISIONAL — first-experiment
  // placeholders, not tuned/final values (per instruction: "Do not invent
  // a new final Crossing duration yet... treat it as experimental").
  //
  // WORLD_HOLD_DURATION: a brief pause once materialPhase first reaches
  // "liquid" (liquidMix===1), before the Games reveal begins. Short and
  // deliberate: this is NOT a destination in itself (per instruction,
  // "This is not a pause or destination. It is the continuity point from
  // which the next transformation begins.") — just long enough that the
  // fully-liquid Home state is unambiguously perceived before the surface
  // starts carrying new content.
  const WORLD_HOLD_DURATION = 350; // ms — provisional

  // WORLD_REVEAL_DURATION: how long the Home->Games worldMix ramp takes.
  // Derived from docs/the-choreography-of-the-crossing.md's authoritative
  // 5-phase, 5.0s timeline: Phase III "Transformation" (1200-2800ms, the
  // doc's own "richest perceptual state") + Phase IV "Passage" (2800-
  // 4200ms, "no longer observing a transforming page") = 1.6s + 1.4s =
  // 3.0s. That pairing is this experiment's reasoning for treating those
  // two phases together as "the interval during which content itself
  // changes," distinct from Phase I/II (approach/destabilization, already
  // covered by the unchanged LIQUID_ENGAGE_DURATION acquisition) and
  // Phase V (Arrival/solidification, explicitly NOT implemented here).
  // Reported in full in NOTE.txt; not implemented as several tuned
  // variants per instruction.
  // --- Crossing v3.1 addition (this pass) — PART B: independent temporal
  // progressions for FORMATION vs. FIRST SIGHT/TRANSFER. ---
  //
  // v3 drove the entire worldMix ramp (Stage A + B + C together) from ONE
  // shared easeMaterial() smoothstep over a single WORLD_REVEAL_DURATION,
  // with STAGE_A_FORMATION_END merely marking a THRESHOLD partway along
  // that one curve. Diagnosed cause of the "passage feels too fast"
  // real-device report: smoothstep's rate of change is 6c(1-c) for raw
  // progress c in [0,1] — zero at both ends, maximum at c=0.5. Stage A's
  // threshold (worldMix<=0.30) is crossed at raw progress c ~= 0.363 (the
  // point where c*c*(3-2c)=0.30), where the curve's velocity is already
  // ~92% of its peak. So Stage A consumed the curve's slow beginning,
  // and Stage B/C inherited a curve already near maximum velocity right
  // at its own start — a jarring, un-diagnosable-in-real-time
  // acceleration exactly at the FORMATION -> FIRST SIGHT handoff, on top
  // of Stage A's own necessarily-subtle (no darkening, per instruction)
  // signal reading as closer to a dead hold than a developing motion.
  //
  // The fix: FORMATION and FIRST SIGHT/TRANSFER are now driven by two
  // genuinely separate clocks and separate easing functions inside
  // updateMaterialTransition()'s "revealing" branch below — not two
  // thresholds sliced from one shared curve. Each one's own progress
  // variable starts at its own t=0 with its own velocity profile:
  //
  //   FORMATION_DURATION (this stage's own clock) uses a LINEAR ramp
  //   (constant, nonzero velocity throughout) — chosen specifically so
  //   Stage A has no near-zero-velocity opening stretch (smoothstep's
  //   own slow start is exactly the kind of "dead hold where nothing
  //   happens" the instruction warns against) and remains continuously,
  //   legibly evolving for its entire duration, by construction.
  //
  //   REVEAL_TRANSFER_DURATION (its own, separately-anchored clock,
  //   started fresh the instant FORMATION completes) reuses the SAME
  //   easeMaterial() smoothstep v1/v2/v3 already used — but now scoped
  //   to only this stage's own duration, so it starts at zero velocity
  //   (a gentle onset for first-sight content, not a snap-in at whatever
  //   speed Stage A happened to end at) and eases back down approaching
  //   the held "revealed" endpoint.
  //
  // Total duration: 3000ms (v1/v2/v3, unchanged) -> 3300ms, a modest
  // (10%) increase, not an arbitrary lengthening — redistribution and
  // independent easing were tried first (they are the entire mechanism
  // above); the increase reflects that Stage A's signal is inherently
  // more subtle than Stage B/C's (no color change, displacement only, by
  // this pass's own frozen constraint) and so benefits from a somewhat
  // larger, not merely differently-shaped, share of the total. See
  // NOTE.txt for the full perceptual justification and the frame-by-frame
  // validation this produced.
  const FORMATION_DURATION = 1300; // ms — Stage A's own independent duration

  // --- Crossing v3.4 correction (T0-T3 choreography) ---
  // Diagnosed BEFORE this change (defect-analysis/v34-t0t3-dense-diagnosis.js,
  // run against the unmodified v3.3 candidate): the old single "transfer"
  // clock put the first non-zero Games contribution at only ~296ms after
  // T0 (FORMATION complete) on BOTH devices, with zero dedicated interval
  // in which a viewer could register "an opening has formed" before any
  // Games content appeared — exactly the real-device complaint ("Crossing
  // rápido... o texto ainda chega antes da abertura do portal"). The old
  // REVEAL_TRANSFER_DURATION (2000ms, one clock, one linear ramp — v3.3's
  // own fix for a DIFFERENT defect, pacing unevenness, which remains
  // correct and is preserved in spirit below) is replaced by THREE
  // independently-clocked, independently-eased segments, matching this
  // codebase's own established pattern of "each named perceptual stage
  // gets its own clock" (FORMATION vs. the old single TRANSFER stage was
  // the v3.1 precedent; this pass extends the same idea one level deeper).
  //
  //   RECOGNITION (T0->T1): worldMix HOLDS EXACTLY at STAGE_A_FORMATION_END
  //   for this whole interval — not a new gate, but a direct reuse of the
  //   EXISTING, already-proven algebraic guarantee that
  //   worldBlend===0 for every pixel whenever uWorldMix<=uFormationEnd
  //   (see MATERIAL_SHADER's own boundary-guarantee comment, unchanged).
  //   Games contribution is therefore exactly zero throughout, by
  //   construction, with no new shader logic. The water simulation itself
  //   keeps running throughout (ambientWater()/updateWater() are functions
  //   of real time and are never paused) — so the aperture keeps visibly
  //   "breathing" during this hold, per instruction section 5, even though
  //   worldMix itself does not advance.
  //
  //   DISCOVERY (T1->T2): worldMix advances from STAGE_A_FORMATION_END
  //   toward DISCOVERY_GAMES_TIME_SPLIT (a gamesTimeInput fraction, not a
  //   worldMix value — converted below), using a quadratic EASE-IN
  //   (progress^2: near-zero velocity at T1, accelerating toward T2) —
  //   deliberately mirrors FORMATION's own "give the subtle/contained
  //   signal room to be noticed" logic, but inverted in shape (FORMATION
  //   needed constant velocity to avoid ANY dead stretch; DISCOVERY
  //   deliberately WANTS a slow, readable opening beat right after
  //   RECOGNITION, then gathers pace as it hands off to PASSAGE).
  //   DISCOVERY_GAMES_TIME_SPLIT=0.4 was chosen from this pass's own
  //   diagnosis of the EXISTING (frozen, unchanged) shader math: at
  //   gamesTimeInput=0.4, v3.3's own checkpoint table already showed
  //   home-contribution still at 89.7% (desktop) / 90.9% (iphone) — i.e.
  //   Games genuinely stays small and subordinate up to this point, so it
  //   is a natural, evidence-based place to call "discovery has happened,
  //   commitment begins," not an arbitrary split.
  //
  //   PASSAGE (T2->T3): worldMix continues from that same point to 1.0,
  //   using a quadratic EASE-OUT (1-(1-progress)^2: fast at T2, continuing
  //   DISCOVERY's momentum, decelerating toward T3) — produces the
  //   "settle rather than snap" ending the instruction asks for, while
  //   still being the fastest-moving segment overall (matching "the
  //   middle of the passage may move faster than FIRST SIGHT").
  //
  // Total T1->T3 (DISCOVERY_DURATION + PASSAGE_DURATION) = 3200ms, inside
  // the instructed 3.0-4.0s design range; RECOGNITION_DURATION=400ms is
  // inside the instructed 300-500ms range. Both were validated (not just
  // assumed) after implementation — see NOTE.txt Part C for the
  // re-measured, after-the-fact T0/T1/T2/T3 timing and the checkpoint
  // captures confirming each segment reads as intended.
  const RECOGNITION_DURATION = 400; // ms — T0->T1, Games held at exactly zero
  const DISCOVERY_DURATION = 1400; // ms — T1->T2, contained/subordinate first sight
  const PASSAGE_DURATION = 1800; // ms — T2->T3, commitment, settles rather than snaps
  const DISCOVERY_GAMES_TIME_SPLIT = 0.4; // gamesTimeInput value reached at T2 — see comment above
  const REVEAL_TRANSFER_DURATION = RECOGNITION_DURATION + DISCOVERY_DURATION + PASSAGE_DURATION; // 3600ms — derived, reported to __mvCrossing.getWorldDurations() as before
  const WORLD_REVEAL_DURATION = FORMATION_DURATION + REVEAL_TRANSFER_DURATION; // 4900ms total — derived, not independently set

  // --- Games Arrival Experiment 01 addition ---
  // ARRIVAL_DURATION is NOT derived from any physical decay measured in
  // the water field — the T3 diagnosis (defect-analysis/t3-diagnosis.js)
  // found the field does NOT naturally settle on any Arrival-relevant
  // timescale (ambientSlopeMagnitude.rms and impactSlopeMagnitude.rms are
  // both still comparable in magnitude, and impactSlopeMagnitude.rms
  // actually INCREASES over a 4.2s post-T3 observation window on both
  // desktop and iphone — see NOTE.txt Part A). There is nothing physical
  // to time this against; the duration is therefore an external, artistic
  // choice, made within the instructed 1.5-3.0s exploration range and
  // justified instead by checkpoint/typography readability (see NOTE.txt
  // Part D for the after-the-fact validation of this choice).
  const ARRIVAL_DURATION = 2200; // ms — T3 -> Arrival-stable; see comment above

  // --- Crossing v3 addition, retained unchanged in v3.1 ---
  // STAGE_A_FORMATION_END is still the exact worldMix value at which
  // FORMATION completes and FIRST SIGHT begins, still passed to the
  // shader as uFormationEnd, still the boundary MATERIAL_SHADER's hard
  // gate and spatial containment math key off — none of that shader-side
  // logic changed in v3.1 (see PART B's own note in updateMaterialTransition()
  // for what DID change: how worldMix's JS-side value reaches this point
  // over time, not what the shader does with it once it arrives). 0.30
  // continues to mean "30% of the way from Home-liquid to Games-liquid,"
  // now reached via FORMATION_DURATION's own linear clock rather than as
  // a threshold along a shared curve.
  const STAGE_A_FORMATION_END = 0.30;

  const SIMULATION_LONG_SIDE = 256;
  const SIMULATION_MIN_SIDE = 96;
  const MAX_SIMULATION_STEPS = 4;

  // Candidate C, Stage C2 — the exact, hash-locked Candidate C1 step-400
  // snapshot, embedded verbatim (byte-for-byte, via this same base64
  // payload) from material-validation-v3-candidateC-c1/snapshot-step400/
  // water-state-step400.base64.txt. Not regenerated, not re-derived —
  // copied. sha256 of the base64 TEXT file this was copied from:
  // 4b2aa7c1a91fca0884359592d03e758100af77e08615705c13950243ed10ebea
  // sha256 of the DECODED raw RGBA bytes (matches C1's own
  // c1-comparison-report.json step400Snapshot.sha256):
  // 6f782313a00b2b93713a9d46f96b5945cea8f072608a99639ad24d32415ff6e0
  const CANDIDATE_C1_SNAPSHOT_STEP400 = Object.freeze({
    width: 256,
    height: 150,
    pixelsBase64: "gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIEA/4GBAP+AfgD/gYAA/4B+AP9/fQD/gYMA/4KDAP+AggD/foMA/3+CAP9+ggD/gIMA/36AAP9+gAD/f4AA/36EAP+BhAD/gIMA/36GAP96ggD/fYkA/3yAAP98fwD/f4EA/3p6AP96hQD/eH8A/3eCAP93ggD/eH8A/3qFAP96egD/f4EA/3x/AP98gAD/fYkA/3qCAP9+hgD/gIMA/4GEAP9+hAD/f4AA/36AAP9+gAD/gIMA/36CAP9/ggD/foMA/4CCAP+CgwD/gYMA/399AP+AfgD/gYAA/4B+AP+BgQD/gIEA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+BgQD/goAA/4B8AP9+hAD/gIQA/4KCAP+BggD/gYQA/4GAAP+CggD/gX8A/36BAP+AgAD/gYQA/4CEAP+DhQD/f4MA/3+CAP9+gAD/fX4A/3+AAP97fAD/eoIA/3qEAP96gAD/d4EA/3yCAP97hAD/eH8A/3eCAP92ggD/doIA/3eCAP94fwD/e4QA/3yCAP93gQD/eoAA/3qEAP96ggD/e3wA/3+AAP99fgD/foAA/3+CAP9/gwD/g4UA/4CEAP+BhAD/gIAA/36BAP+BfwD/goIA/4GAAP+BhAD/gYIA/4KCAP+AhAD/foQA/4B8AP+CgAD/gYEA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfwD/fn0A/4F/AP+BgAD/gH4A/39/AP+BgQD/gYQA/4GBAP+BggD/foAA/4CDAP97gQD/fn8A/36DAP9/hAD/goMA/36DAP+AhAD/goMA/32BAP94fQD/fIIA/3x/AP98ggD/e4IA/3iBAP96hQD/eX8A/3h/AP96gAD/eIIA/3iCAP96gAD/eH8A/3l/AP96hQD/eIEA/3uCAP98ggD/fH8A/3yCAP94fQD/fYEA/4KDAP+AhAD/foMA/4KDAP9/hAD/foMA/35/AP97gQD/gIMA/36AAP+BggD/gYEA/4GEAP+BgQD/f38A/4B+AP+BgAD/gX8A/359AP+AfwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gH8A/35+AP99fQD/fYAA/4GEAP+CfQD/f3wA/4F/AP9/gQD/fn8A/4CEAP+AfQD/f4EA/35+AP99gQD/eoMA/3x/AP99fwD/fIIA/3yFAP98ggD/f4MA/36BAP+AhAD/fIYA/32LAP98iQD/f4QA/32EAP95gwD/d4AA/3mAAP95gQD/eH4A/3mDAP95gwD/eH4A/3mBAP95gAD/d4AA/3mDAP99hAD/f4QA/3yJAP99iwD/fIYA/4CEAP9+gQD/f4MA/3yCAP98hQD/fIIA/31/AP98fwD/eoMA/32BAP9+fgD/f4EA/4B9AP+AhAD/fn8A/3+BAP+BfwD/f3wA/4J9AP+BhAD/fYAA/319AP9+fgD/gH8A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/f30A/35+AP98ggD/fYIA/36BAP9+fgD/f4AA/3+AAP+BfgD/goQA/4OBAP+BfgD/goAA/4KCAP9/fgD/gYAA/35/AP98fwD/e30A/3x8AP96fwD/e4EA/3uDAP95ggD/eoUA/3qCAP96egD/eoAA/3yEAP97hAD/eYIA/3iDAP94hAD/doYA/3iGAP92hAD/doQA/3iGAP92hgD/eIQA/3iDAP95ggD/e4QA/3yEAP96gAD/enoA/3qCAP96hQD/eYIA/3uDAP97gQD/en8A/3x8AP97fQD/fH8A/35/AP+BgAD/f34A/4KCAP+CgAD/gX4A/4OBAP+ChAD/gX4A/3+AAP9/gAD/fn4A/36BAP99ggD/fIIA/35+AP9/fQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfwD/fn0A/36BAP9+gwD/f4MA/4GDAP99fgD/foQA/4CCAP99fwD/gYIA/4KCAP+EgAD/g4IA/4OCAP+CgAD/goAA/4F/AP+BfgD/f38A/31+AP9+gwD/fXwA/317AP99ewD/enwA/3h9AP96gQD/eX8A/3l/AP96ggD/e4MA/3mDAP93gwD/d4YA/3SBAP94fwD/eIQA/3iEAP94fwD/dIEA/3eGAP93gwD/eYMA/3uDAP96ggD/eX8A/3l/AP96gQD/eH0A/3p8AP99ewD/fXsA/318AP9+gwD/fX4A/39/AP+BfgD/gX8A/4KAAP+CgAD/g4IA/4OCAP+EgAD/goIA/4GCAP99fwD/gIIA/36EAP99fgD/gYMA/3+DAP9+gwD/foEA/359AP+AfwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9+fQD/foAA/3+CAP+AfgD/fHwA/319AP9/fQD/fn0A/4F+AP+AgAD/f34A/4B9AP+BfwD/hX8A/4OCAP+DfgD/g4AA/4N/AP+CfgD/gn0A/4F/AP+CgAD/gHwA/4B7AP98fQD/f3sA/3t8AP98fgD/e34A/3uBAP98fgD/eYAA/3p+AP97fgD/eH4A/3WBAP94gwD/dX4A/3eAAP93gAD/dX4A/3iDAP91gQD/eH4A/3t+AP96fgD/eYAA/3x+AP97gQD/e34A/3x+AP97fAD/f3sA/3x9AP+AewD/gHwA/4KAAP+BfwD/gn0A/4J+AP+DfwD/g4AA/4N+AP+DggD/hX8A/4F/AP+AfQD/f34A/4CAAP+BfgD/fn0A/399AP99fQD/fHwA/4B+AP9/ggD/foAA/359AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/foEA/39+AP9/gAD/fYEA/3yAAP99gAD/foIA/4CEAP+AfgD/gIAA/4GAAP9/gQD/gXwA/4F/AP+AfgD/gH8A/4KBAP+FhAD/hH8A/4V/AP+DfAD/g38A/4CCAP+AgAD/f34A/35+AP9/fQD/gXwA/3+AAP+AfQD/f30A/3x5AP98fAD/e3wA/3h6AP96ggD/engA/3WBAP92fgD/dn4A/3WBAP96eAD/eoIA/3h6AP97fAD/fHwA/3x5AP9/fQD/gH0A/3+AAP+BfAD/f30A/35+AP9/fgD/gIAA/4CCAP+DfwD/g3wA/4V/AP+EfwD/hYQA/4KBAP+AfwD/gH4A/4F/AP+BfAD/f4EA/4GAAP+AgAD/gH4A/4CEAP9+ggD/fYAA/3yAAP99gQD/f4AA/39+AP9+gQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4GDAP+AfwD/gIAA/32CAP9/fgD/fIEA/3+AAP9/gAD/gH8A/4CBAP+CfwD/f4AA/4CBAP+BfgD/f4EA/36BAP+BfQD/hXsA/4SCAP+FfwD/hX8A/4SCAP+FgwD/gYEA/4SEAP+EggD/g4EA/4SCAP+DgAD/gX0A/4F9AP9+fQD/fn4A/4B+AP+AfgD/gHoA/4GAAP+BgQD/e3sA/3t7AP+BgQD/gYAA/4B6AP+AfgD/gH4A/35+AP9+fQD/gX0A/4F9AP+DgAD/hIIA/4OBAP+EggD/hIQA/4GBAP+FgwD/hIIA/4V/AP+FfwD/hIIA/4V7AP+BfQD/foEA/3+BAP+BfgD/gIEA/3+AAP+CfwD/gIEA/4B/AP9/gAD/f4AA/3yBAP9/fgD/fYIA/4CAAP+AfwD/gYMA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+CgQD/gYIA/398AP+BhAD/f4IA/3+AAP+AfQD/gn4A/4GCAP+CgwD/gX4A/4GCAP9/fgD/gH4A/4OFAP+BggD/gYAA/4OBAP+EgAD/hX0A/4eDAP+FhwD/hn4A/4SCAP+EgQD/hX0A/4WCAP+GggD/hX0A/4WBAP+CfQD/gYIA/4J+AP+BggD/gnwA/4GCAP+CfQD/gIEA/359AP9+fQD/gIEA/4J9AP+BggD/gnwA/4GCAP+CfgD/gYIA/4J9AP+FgQD/hX0A/4aCAP+FggD/hX0A/4SBAP+EggD/hn4A/4WHAP+HgwD/hX0A/4SAAP+DgQD/gYAA/4GCAP+DhQD/gH4A/39+AP+BggD/gX4A/4KDAP+BggD/gn4A/4B9AP9/gAD/f4IA/4GEAP9/fAD/gYIA/4KBAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIIA/4GCAP+AfgD/gYIA/39+AP+AfwD/gYEA/4B+AP+CfwD/gX4A/4F/AP+CgAD/gn8A/4WEAP+FdwD/g4IA/4aEAP+GhgD/hoIA/4aCAP+HgwD/hYIA/4N+AP+FhAD/hYEA/4h/AP+GgAD/h38A/4R6AP+GgQD/g4IA/4OCAP+EewD/goAA/4J/AP+BfAD/gX4A/4OBAP+EhwD/hIcA/4OBAP+BfgD/gXwA/4J/AP+CgAD/hHsA/4OCAP+DggD/hoEA/4R6AP+HfwD/hoAA/4h/AP+FgQD/hYQA/4N+AP+FggD/h4MA/4aCAP+GggD/hoYA/4aEAP+DggD/hXcA/4WEAP+CfwD/goAA/4F/AP+BfgD/gn8A/4B+AP+BgQD/gH8A/39+AP+BggD/gH4A/4GCAP+AggD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/359AP9+ggD/f4MA/35/AP+AfgD/gIAA/4CAAP+AgAD/gH4A/4B+AP+AfQD/f30A/4GAAP+AfgD/goAA/4F8AP+BgAD/gX4A/4GEAP+BfQD/gYAA/4OAAP+BggD/gHsA/4J9AP+IggD/hHsA/4Z+AP+GgAD/hX0A/4aAAP+FfwD/hHwA/4V/AP+IfQD/iIMA/4eCAP+GfQD/hYUA/4eBAP+HgAD/hYAA/4KGAP+BfwD/gn8A/4OCAP+DfwD/hIAA/4SAAP+DfwD/g4IA/4J/AP+BfwD/goYA/4WAAP+HgAD/h4EA/4WFAP+GfQD/h4IA/4iDAP+IfQD/hX8A/4R8AP+FfwD/hoAA/4V9AP+GgAD/hn4A/4R7AP+IggD/gn0A/4B7AP+BggD/g4AA/4GAAP+BfQD/gYQA/4F+AP+BgAD/gXwA/4KAAP+AfgD/gYAA/399AP+AfQD/gH4A/4B+AP+AgAD/gIAA/4CAAP+AfgD/fn8A/3+DAP9+ggD/fn0A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9+gQD/gIQA/35+AP9/fwD/fn8A/4GCAP+AggD/gIAA/4B+AP+AfQD/gH8A/359AP+AgAD/gIUA/4F/AP9/fgD/gIMA/4N/AP+EfwD/g4AA/4SAAP+JfwD/g4AA/4KIAP+HhAD/h38A/4WAAP+IfAD/ioAA/4h/AP+GhQD/hX8A/4aAAP+GgQD/hX4A/4eAAP+EgAD/hIIA/4V9AP+EfgD/h4AA/4WHAP+CgQD/gn0A/4SCAP+FhwD/g38A/4J8AP+CfAD/g38A/4WHAP+EggD/gn0A/4KBAP+FhwD/h4AA/4R+AP+FfQD/hIIA/4SAAP+HgAD/hX4A/4aBAP+GgAD/hX8A/4aFAP+IfwD/ioAA/4h8AP+FgAD/h38A/4eEAP+CiAD/g4AA/4l/AP+EgAD/g4AA/4R/AP+DfwD/gIMA/39+AP+BfwD/gIUA/4CAAP9+fQD/gH8A/4B9AP+AfgD/gIAA/4CCAP+BggD/fn8A/39/AP9+fgD/gIQA/36BAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/f4MA/39/AP9+ggD/f38A/3+BAP+AgwD/gIIA/4B/AP+BfQD/goEA/35/AP9/gwD/f30A/4OBAP+ChQD/gYUA/4CBAP+DhAD/goIA/4J/AP+FgwD/hoIA/4SBAP+FfgD/h4MA/4eEAP+FggD/hX0A/4t/AP+LhAD/iIAA/4eCAP+GhAD/hIIA/4SAAP+FgQD/g4MA/4J9AP+CegD/hYIA/4Z8AP+GhwD/hoAA/4SDAP+DggD/gYQA/4N/AP+BfQD/gX0A/4N/AP+BhAD/g4IA/4SDAP+GgAD/hocA/4Z8AP+FggD/gnoA/4J9AP+DgwD/hYEA/4SAAP+EggD/hoQA/4eCAP+IgAD/i4QA/4t/AP+FfQD/hYIA/4eEAP+HgwD/hX4A/4SBAP+GggD/hYMA/4J/AP+CggD/g4QA/4CBAP+BhQD/goUA/4OBAP9/fQD/f4MA/35/AP+CgQD/gX0A/4B/AP+AggD/gIMA/3+BAP9/fwD/foIA/39/AP9/gwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CDAP9/ggD/f38A/3+BAP+CgwD/g4EA/4KEAP+AfgD/goIA/4N9AP9+fQD/gH8A/397AP+CgwD/hIIA/4B+AP+CgQD/g4MA/4OGAP+FhQD/hoUA/4Z7AP+GiAD/h38A/4d/AP+IfAD/hYQA/4h/AP+IgwD/h4AA/4iCAP+IggD/hn4A/4aDAP+FggD/gYQA/4OAAP+FfwD/gYoA/4OAAP+FggD/g34A/4aBAP+EfQD/g4EA/4KAAP+CggD/gn4A/4J+AP+CggD/goAA/4OBAP+EfQD/hoEA/4N+AP+FggD/g4AA/4GKAP+FfwD/g4AA/4GEAP+FggD/hoMA/4Z+AP+IggD/iIIA/4eAAP+IgwD/iH8A/4WEAP+IfAD/h38A/4d/AP+GiAD/hnsA/4aFAP+FhQD/g4YA/4ODAP+CgQD/gH4A/4SCAP+CgwD/f3sA/4B/AP9+fQD/g30A/4KCAP+AfgD/goQA/4OBAP+CgwD/f4EA/39/AP9/ggD/gIMA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9/fgD/f34A/4CEAP+AgQD/goMA/4KCAP+AgQD/fX8A/4B9AP+EgQD/g4AA/4GAAP+AhQD/gH0A/4F+AP9+ggD/gX4A/4SFAP+FgwD/hX8A/4N9AP+FgwD/iIEA/4d+AP+IgwD/iYQA/4V9AP+FgQD/h4UA/4WAAP+HggD/iX0A/4mAAP+HgwD/hYMA/4eDAP+AgAD/g34A/4OAAP+FfgD/hH4A/4N+AP+CggD/hYUA/4WAAP+FgAD/hIEA/4OBAP+DgQD/hIEA/4WAAP+FgAD/hYUA/4KCAP+DfgD/hH4A/4V+AP+DgAD/g34A/4CAAP+HgwD/hYMA/4eDAP+JgAD/iX0A/4eCAP+FgAD/h4UA/4WBAP+FfQD/iYQA/4iDAP+HfgD/iIEA/4WDAP+DfQD/hX8A/4WDAP+EhQD/gX4A/36CAP+BfgD/gH0A/4CFAP+BgAD/g4AA/4SBAP+AfQD/fX8A/4CBAP+CggD/goMA/4CBAP+AhAD/f34A/39+AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/fn4A/4GDAP+BggD/gIEA/4R/AP+BfgD/gX4A/39+AP9/ggD/gYIA/4OCAP+CfgD/f38A/4J+AP+EgQD/goAA/4SCAP+DfgD/g4AA/4V+AP+GgAD/hIEA/4Z7AP+HegD/iX8A/4uEAP+HgwD/hoMA/4eBAP+HggD/hIAA/4iEAP+IfgD/h4EA/4N8AP+DgAD/hH4A/4WAAP+DgwD/gH0A/4SDAP+FgQD/g38A/4iEAP+FgQD/h3wA/4iIAP+HgQD/h4EA/4iIAP+HfAD/hYEA/4iEAP+DfwD/hYEA/4SDAP+AfQD/g4MA/4WAAP+EfgD/g4AA/4N8AP+HgQD/iH4A/4iEAP+EgAD/h4IA/4eBAP+GgwD/h4MA/4uEAP+JfwD/h3oA/4Z7AP+EgQD/hoAA/4V+AP+DgAD/g34A/4SCAP+CgAD/hIEA/4J+AP9/fwD/gn4A/4OCAP+BggD/f4IA/39+AP+BfgD/gX4A/4R/AP+AgQD/gYIA/4GDAP9+fgD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgQD/goIA/4OAAP9/fQD/f34A/4KEAP+AfgD/goMA/358AP9/gAD/gn4A/4OEAP+CgAD/hIIA/4R+AP+CfgD/hIMA/4SEAP+EfwD/hYAA/4R+AP+EfQD/hH0A/4h+AP+FfgD/hX4A/4aEAP+EfAD/h3gA/4aDAP+IfgD/iIAA/4V+AP+EgAD/g3sA/4ODAP+FfQD/goYA/4GCAP+DfQD/g3sA/4OEAP+GfgD/h4EA/4h9AP+HgAD/h4EA/4eBAP+HgAD/iH0A/4eBAP+GfgD/g4QA/4N7AP+DfQD/gYIA/4KGAP+FfQD/g4MA/4N7AP+EgAD/hX4A/4iAAP+IfgD/hoMA/4d4AP+EfAD/hoQA/4V+AP+FfgD/iH4A/4R9AP+EfQD/hH4A/4WAAP+EfwD/hIQA/4SDAP+CfgD/hH4A/4SCAP+CgAD/g4QA/4J+AP9/gAD/fnwA/4KDAP+AfgD/goQA/39+AP9/fQD/g4AA/4KCAP+AgQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIIA/4KAAP+CfwD/gX4A/4OAAP+CfQD/fXwA/4B+AP+CfgD/gIMA/4F+AP+CgwD/goQA/4KAAP+DggD/goAA/4eDAP+GhAD/hYEA/4aDAP+FewD/g4AA/4R+AP+DfAD/hX0A/4WAAP+EggD/iH0A/4eEAP+GegD/h4QA/4Z+AP+HegD/iH8A/4Z+AP+FggD/g4MA/4WBAP+EewD/hIMA/4SFAP+DhgD/gn8A/4WDAP+EgwD/h3sA/4R9AP+KfgD/hIIA/4aAAP+GgAD/hIIA/4p+AP+EfQD/h3sA/4SDAP+FgwD/gn8A/4OGAP+EhQD/hIMA/4R7AP+FgQD/g4MA/4WCAP+GfgD/iH8A/4d6AP+GfgD/h4QA/4Z6AP+HhAD/iH0A/4SCAP+FgAD/hX0A/4N8AP+EfgD/g4AA/4V7AP+GgwD/hYEA/4aEAP+HgwD/goAA/4OCAP+CgAD/goQA/4KDAP+BfgD/gIMA/4J+AP+AfgD/fXwA/4J9AP+DgAD/gX4A/4J/AP+CgAD/gIIA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gYMA/4KBAP+BfgD/gX4A/4KDAP+CfwD/f38A/3+BAP+BggD/gYIA/35/AP+BggD/gn0A/4J/AP+FgQD/hYAA/4aBAP+GgwD/hXoA/4OGAP+CgAD/gnwA/4Z+AP+GgQD/hH4A/4V+AP+GfgD/g38A/4eBAP+HgQD/hYQA/4iEAP+EgAD/iIEA/4Z/AP+HgQD/iH8A/4V/AP+EfgD/gn4A/4R8AP+DfAD/gH8A/4B+AP+EhQD/g34A/4WAAP+GfgD/h30A/4eDAP+KgQD/ioEA/4eDAP+HfQD/hn4A/4WAAP+DfgD/hIUA/4B+AP+AfwD/g3wA/4R8AP+CfgD/hH4A/4V/AP+IfwD/h4EA/4Z/AP+IgQD/hIAA/4iEAP+FhAD/h4EA/4eBAP+DfwD/hn4A/4V+AP+EfgD/hoEA/4Z+AP+CfAD/goAA/4OGAP+FegD/hoMA/4aBAP+FgAD/hYEA/4J/AP+CfQD/gYIA/35/AP+BggD/gYIA/3+BAP9/fwD/gn8A/4KDAP+BfgD/gX4A/4KBAP+BgwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gYMA/4KBAP+DfwD/goEA/4GCAP+CgAD/g4IA/4SDAP9/fwD/gX4A/4F8AP+AfwD/gIIA/4KCAP+DggD/g4EA/4aCAP+FegD/h4IA/4aAAP+DgAD/hIIA/4aCAP+HfgD/hnsA/4aBAP+GggD/hoAA/4V6AP+GggD/h4QA/4p/AP+IgAD/hnkA/4mCAP+KhAD/iIAA/4h/AP+GhgD/hYEA/4F+AP+BgwD/hIIA/4B+AP+BfgD/hIAA/4J9AP+CfAD/h4QA/4iCAP+HhgD/gn8A/4J/AP+HhgD/iIIA/4eEAP+CfAD/gn0A/4SAAP+BfgD/gH4A/4SCAP+BgwD/gX4A/4WBAP+GhgD/iH8A/4iAAP+KhAD/iYIA/4Z5AP+IgAD/in8A/4eEAP+GggD/hXoA/4aAAP+GggD/hoEA/4Z7AP+HfgD/hoIA/4SCAP+DgAD/hoAA/4eCAP+FegD/hoIA/4OBAP+DggD/goIA/4CCAP+AfwD/gXwA/4F+AP9/fwD/hIMA/4OCAP+CgAD/gYIA/4KBAP+DfwD/goEA/4GDAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gYMA/4KBAP+BfQD/hYIA/4OCAP+DfgD/gn4A/4R+AP+DfAD/gX0A/4B/AP+AfQD/gIEA/4SDAP+DfwD/hX0A/4OCAP+FggD/h4MA/4OBAP+FgAD/hoAA/4R9AP+GfAD/gnwA/4WCAP+GhgD/hYAA/4V+AP+GfwD/iH8A/4l+AP+LfwD/hX8A/4Z/AP+IfgD/iH4A/4eCAP+JggD/iIYA/4Z/AP+EgQD/gn8A/4OAAP+CfgD/gX4A/4B/AP+BfwD/hYQA/4V7AP+HfwD/hn4A/4V7AP+FewD/hn4A/4d/AP+FewD/hYQA/4F/AP+AfwD/gX4A/4J+AP+DgAD/gn8A/4SBAP+GfwD/iIYA/4mCAP+HggD/iH4A/4h+AP+GfwD/hX8A/4t/AP+JfgD/iH8A/4Z/AP+FfgD/hYAA/4aGAP+FggD/gnwA/4Z8AP+EfQD/hoAA/4WAAP+DgQD/h4MA/4WCAP+DggD/hX0A/4N/AP+EgwD/gIEA/4B9AP+AfwD/gX0A/4N8AP+EfgD/gn4A/4N+AP+DggD/hYIA/4F9AP+CgQD/gYMA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gYMA/4KBAP+BfQD/g4MA/4SBAP+DfwD/gn0A/4WCAP+DfgD/hIAA/4J+AP+BgAD/goUA/4GBAP+CgAD/hX0A/4eFAP+IggD/hX8A/4V8AP+FfgD/iH8A/4aBAP+AfQD/hX8A/4d/AP+IgwD/hnwA/4eHAP+GggD/in4A/4J9AP+GfAD/ioIA/4l/AP+IhQD/hoMA/4Z+AP+HgAD/iH8A/4iDAP+JfQD/hoIA/4R+AP+EfgD/hIMA/4SHAP+FhQD/gn8A/4h/AP+HgwD/hoIA/4aDAP+GgQD/hoEA/4aDAP+GggD/h4MA/4h/AP+CfwD/hYUA/4SHAP+EgwD/hH4A/4R+AP+GggD/iX0A/4iDAP+IfwD/h4AA/4Z+AP+GgwD/iIUA/4l/AP+KggD/hnwA/4J9AP+KfgD/hoIA/4eHAP+GfAD/iIMA/4d/AP+FfwD/gH0A/4aBAP+IfwD/hX4A/4V8AP+FfwD/iIIA/4eFAP+FfQD/goAA/4GBAP+ChQD/gYAA/4J+AP+EgAD/g34A/4WCAP+CfQD/g38A/4SBAP+DgwD/gX0A/4KBAP+BgwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gYMA/4KBAP+BfQD/goIA/4WDAP+DfAD/hH8A/4R/AP+CfQD/goAA/4SBAP+CfQD/gX8A/4CCAP+BgAD/g4cA/4V/AP+FfgD/h4MA/4d/AP+GfQD/hH0A/4OBAP+GggD/h38A/4OCAP+GggD/iYIA/4l6AP+IggD/iIMA/4eBAP+FfwD/iYUA/4mCAP+JgQD/hn8A/4WAAP+DewD/hoIA/4h/AP+JfwD/iYEA/4iDAP+FfgD/gn0A/4B6AP+HhAD/h4AA/4iIAP+IgQD/ioAA/4aBAP+FegD/hYEA/4WBAP+FegD/hoEA/4qAAP+IgQD/iIgA/4eAAP+HhAD/gHoA/4J9AP+FfgD/iIMA/4mBAP+JfwD/iH8A/4aCAP+DewD/hYAA/4Z/AP+JgQD/iYIA/4mFAP+FfwD/h4EA/4iDAP+IggD/iXoA/4mCAP+GggD/g4IA/4d/AP+GggD/g4EA/4R9AP+GfQD/h38A/4eDAP+FfgD/hX8A/4OHAP+BgAD/gIIA/4F/AP+CfQD/hIEA/4KAAP+CfQD/hH8A/4R/AP+DfAD/hYMA/4KCAP+BfQD/goEA/4GDAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gYMA/4KBAP+BfQD/g4MA/4WDAP+EggD/hH8A/4V/AP+GggD/hYIA/4SFAP+EfwD/g30A/4N8AP+AfwD/hIIA/4WDAP+FggD/hoIA/4WAAP+GfQD/hnsA/4SAAP+CfgD/hoAA/4V/AP+EgwD/iYcA/4t/AP+JhQD/i4MA/4mCAP+HfgD/iYEA/4yFAP+HgQD/in8A/4Z/AP+IggD/iYQA/4R8AP+EgAD/hoAA/4d8AP+IfwD/iIEA/4mDAP+EgAD/h4YA/4l/AP+FfQD/h4AA/4mBAP+HggD/iIUA/4N8AP+DfAD/iIUA/4eCAP+JgQD/h4AA/4V9AP+JfwD/h4YA/4SAAP+JgwD/iIEA/4h/AP+HfAD/hoAA/4SAAP+EfAD/iYQA/4iCAP+GfwD/in8A/4eBAP+MhQD/iYEA/4d+AP+JggD/i4MA/4mFAP+LfwD/iYcA/4SDAP+FfwD/hoAA/4J+AP+EgAD/hnsA/4Z9AP+FgAD/hoIA/4WCAP+FgwD/hIIA/4B/AP+DfAD/g30A/4R/AP+EhQD/hYIA/4aCAP+FfwD/hH8A/4SCAP+FgwD/g4MA/4F9AP+CgQD/gYMA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIIA/4KBAP+DfwD/hYIA/4SBAP+DfAD/hH8A/4WCAP+EhAD/hIEA/4eAAP+EggD/goEA/4GDAP+CfQD/hIMA/4SCAP+HfwD/h3oA/4aBAP+GfwD/hX4A/4KBAP+CggD/h3sA/4Z/AP+GgAD/hn4A/4mEAP+KggD/jn0A/4uCAP+JgQD/iYEA/4t/AP+MggD/jHwA/4aBAP+IewD/h4QA/4Z8AP+IhAD/ioQA/4WAAP+GggD/h4gA/4eFAP+HfQD/h4AA/4d/AP+FgAD/h4QA/4h7AP+IgAD/hoAA/4Z8AP+GhQD/hoUA/4Z8AP+GgAD/iIAA/4h7AP+HhAD/hYAA/4d/AP+HgAD/h30A/4eFAP+HiAD/hoIA/4WAAP+KhAD/iIQA/4Z8AP+HhAD/iHsA/4aBAP+MfAD/jIIA/4t/AP+JgQD/iYEA/4uCAP+OfQD/ioIA/4mEAP+GfgD/hoAA/4Z/AP+HewD/goIA/4KBAP+FfgD/hn8A/4aBAP+HegD/h38A/4SCAP+EgwD/gn0A/4GDAP+CgQD/hIIA/4eAAP+EgQD/hIQA/4WCAP+EfwD/g3wA/4SBAP+FggD/g38A/4KBAP+AggD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4KAAP+BfgD/goEA/4OCAP+DfwD/hH8A/4V/AP+EhAD/g3wA/4J+AP+FfwD/gn4A/4F+AP+DgwD/goMA/4WCAP+FgQD/hoIA/4aBAP+HgAD/hoAA/4aAAP+GfgD/gX8A/4KBAP+FggD/hYUA/4mBAP+IhAD/iX8A/45+AP+KgQD/h30A/4Z8AP+IfwD/iH4A/4iFAP+KewD/jYQA/4uEAP+KhgD/h4AA/4l/AP+KggD/h4MA/4t9AP+IfwD/h4AA/4iDAP+FegD/h4IA/4V9AP+JgQD/iH8A/4h9AP+KfwD/hYIA/4WCAP+KfwD/iH0A/4h/AP+JgQD/hX0A/4eCAP+FegD/iIMA/4eAAP+IfwD/i30A/4eDAP+KggD/iX8A/4eAAP+KhgD/i4QA/42EAP+KewD/iIUA/4h+AP+IfwD/hnwA/4d9AP+KgQD/jn4A/4l/AP+IhAD/iYEA/4WFAP+FggD/goEA/4F/AP+GfgD/hoAA/4aAAP+HgAD/hoEA/4aCAP+FgQD/hYIA/4KDAP+DgwD/gX4A/4J+AP+FfwD/gn4A/4N8AP+EhAD/hX8A/4R/AP+DfwD/g4IA/4KBAP+BfgD/goAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/359AP9+gQD/f4MA/4CDAP9/fgD/fn4A/4CAAP+CfwD/gX4A/4GCAP+DfgD/gn0A/4R/AP+GggD/hIEA/4J+AP+BfQD/f4AA/39+AP+AgQD/gn8A/4eBAP+GgAD/g30A/4R+AP+EgQD/hoUA/4Z+AP+IfQD/hn8A/4OEAP+HgwD/hX4A/4iCAP+KfgD/hnwA/4eDAP+IfQD/iX4A/4eGAP+LggD/iYEA/4Z8AP+GfgD/h34A/4iFAP+HfQD/jIAA/4mBAP+JgwD/iXwA/4qDAP+MhgD/ioAA/4aAAP+HgwD/hHwA/4aBAP+FfwD/hoEA/4Z+AP+EgAD/h4MA/4h+AP+IfgD/h4MA/4SAAP+GfgD/hoEA/4V/AP+GgQD/hHwA/4eDAP+GgAD/ioAA/4yGAP+KgwD/iXwA/4mDAP+JgQD/jIAA/4d9AP+IhQD/h34A/4Z+AP+GfAD/iYEA/4uCAP+HhgD/iX4A/4h9AP+HgwD/hnwA/4p+AP+IggD/hX4A/4eDAP+DhAD/hn8A/4h9AP+GfgD/hoUA/4SBAP+EfgD/g30A/4aAAP+HgQD/gn8A/4CBAP9/fgD/f4AA/4F9AP+CfgD/hIEA/4aCAP+EfwD/gn0A/4N+AP+BggD/gX4A/4J/AP+AgAD/fn4A/39+AP+AgwD/f4MA/36BAP9+fQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9+ggD/gIQA/39/AP9/ggD/f34A/4GDAP+AgQD/gX4A/4KDAP+CgAD/gn4A/4WCAP+CfQD/hYIA/4eAAP+FfwD/f4AA/4GCAP+CfgD/hIQA/4OCAP+DggD/hoAA/4R9AP+EgAD/iIEA/4Z+AP+IfQD/iYIA/4Z+AP+IgQD/h4UA/4mCAP+JgQD/h3sA/4l3AP+IfgD/h30A/4h+AP+KhQD/in0A/4eBAP+JggD/h4EA/4Z+AP+IggD/hXsA/4d/AP+LfQD/iX4A/4mHAP+JgwD/jIYA/4t9AP+LhQD/h4AA/4R9AP+HggD/h30A/4eFAP+IgQD/h4MA/4mBAP+IfAD/iHwA/4mBAP+HgwD/iIEA/4eFAP+HfQD/h4IA/4R9AP+HgAD/i4UA/4t9AP+MhgD/iYMA/4mHAP+JfgD/i30A/4d/AP+FewD/iIIA/4Z+AP+HgQD/iYIA/4eBAP+KfQD/ioUA/4h+AP+HfQD/iH4A/4l3AP+HewD/iYEA/4mCAP+HhQD/iIEA/4Z+AP+JggD/iH0A/4Z+AP+IgQD/hIAA/4R9AP+GgAD/g4IA/4OCAP+EhAD/gn4A/4GCAP9/gAD/hX8A/4eAAP+FggD/gn0A/4WCAP+CfgD/goAA/4KDAP+BfgD/gIEA/4GDAP9/fgD/f4IA/39/AP+AhAD/foIA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/f4MA/35+AP9+ggD/f38A/4CEAP+BggD/goIA/4OAAP+CfwD/g4IA/4R+AP+DfgD/goAA/4SFAP+EggD/gn4A/39+AP+CfgD/g30A/4OAAP+DfwD/hIIA/4V/AP+GfwD/hX0A/4eBAP+KgQD/iYEA/4qCAP+IfwD/h4AA/4V8AP+JgQD/iX4A/4uJAP+GjgD/h34A/4aDAP+HgAD/h3kA/4uAAP+IgQD/iXUA/4SBAP+BewD/h3wA/4iAAP+FgAD/iYMA/4mCAP+KfgD/hoQA/4yAAP+LiAD/h38A/4iFAP+IhQD/h4IA/4aAAP+FfQD/iIMA/4qBAP+KfQD/ioIA/4qCAP+KfQD/ioEA/4iDAP+FfQD/hoAA/4eCAP+IhQD/iIUA/4d/AP+LiAD/jIAA/4aEAP+KfgD/iYIA/4mDAP+FgAD/iIAA/4d8AP+BewD/hIEA/4l1AP+IgQD/i4AA/4d5AP+HgAD/hoMA/4d+AP+GjgD/i4kA/4l+AP+JgQD/hXwA/4eAAP+IfwD/ioIA/4mBAP+KgQD/h4EA/4V9AP+GfwD/hX8A/4SCAP+DfwD/g4AA/4N9AP+CfgD/f34A/4J+AP+EggD/hIUA/4KAAP+DfgD/hH4A/4OCAP+CfwD/g4AA/4KCAP+BggD/gIQA/39/AP9+ggD/fn4A/3+DAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/35/AP9/fwD/f38A/3+BAP+AgQD/gIEA/4OAAP+CfQD/f38A/4SDAP+DfAD/hIAA/4SBAP+EfwD/goEA/4F+AP+AgQD/hIQA/4OAAP+CgQD/g3sA/4SBAP+FfgD/h4AA/4h/AP+GfgD/hn0A/4h/AP+JgQD/h4UA/4qEAP+HgAD/iYIA/4uAAP+HgAD/h34A/4qEAP+HggD/iYUA/4uBAP+KggD/jIEA/4V/AP+HgAD/gn8A/4N8AP+HhgD/iIMA/4qGAP+LgwD/hnsA/4Z/AP+JfQD/in0A/4iCAP+EgAD/hnwA/4h+AP+LhwD/hoQA/4l+AP+OhgD/joEA/46AAP+OgAD/joEA/46GAP+JfgD/hoQA/4uHAP+IfgD/hnwA/4SAAP+IggD/in0A/4l9AP+GfwD/hnsA/4uDAP+KhgD/iIMA/4eGAP+DfAD/gn8A/4eAAP+FfwD/jIEA/4qCAP+LgQD/iYUA/4eCAP+KhAD/h34A/4eAAP+LgAD/iYIA/4eAAP+KhAD/h4UA/4mBAP+IfwD/hn0A/4Z+AP+IfwD/h4AA/4V+AP+EgQD/g3sA/4KBAP+DgAD/hIQA/4CBAP+BfgD/goEA/4R/AP+EgQD/hIAA/4N8AP+EgwD/f38A/4J9AP+DgAD/gIEA/4CBAP9/gQD/f38A/39/AP9+fwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfgD/fn8A/3+BAP+CgwD/goMA/4R/AP9/fQD/fXwA/3+BAP9/fwD/gX0A/4J+AP+CfQD/g30A/4GDAP+DgwD/gn8A/4OCAP+DfwD/g3sA/4SFAP+EgwD/hX4A/4iCAP+KfgD/iX8A/4mAAP+IfgD/i4AA/4h/AP+IhQD/h38A/4iCAP+LhQD/in0A/4uAAP+LgwD/iX4A/4qCAP+NfQD/iH0A/4mCAP+GgQD/iX8A/4R+AP+EggD/iH8A/4l/AP+LggD/ioAA/4WEAP+HgQD/iogA/4qCAP+JgwD/g4EA/4WDAP+GfgD/iIYA/4WDAP+KgAD/jX8A/4x+AP+NfQD/jX0A/4x+AP+NfwD/ioAA/4WDAP+IhgD/hn4A/4WDAP+DgQD/iYMA/4qCAP+KiAD/h4EA/4WEAP+KgAD/i4IA/4l/AP+IfwD/hIIA/4R+AP+JfwD/hoEA/4mCAP+IfQD/jX0A/4qCAP+JfgD/i4MA/4uAAP+KfQD/i4UA/4iCAP+HfwD/iIUA/4h/AP+LgAD/iH4A/4mAAP+JfwD/in4A/4iCAP+FfgD/hIMA/4SFAP+DewD/g38A/4OCAP+CfwD/g4MA/4GDAP+DfQD/gn0A/4J+AP+BfQD/f38A/3+BAP99fAD/f30A/4R/AP+CgwD/goMA/3+BAP9+fwD/gH4A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4GCAP+AgwD/g4EA/4KCAP+BfgD/f34A/4B+AP+BggD/gX4A/4B/AP+BgAD/gX8A/4N8AP+CfQD/goMA/4eBAP+DggD/hIIA/4SBAP+EgwD/hH4A/4Z/AP+GfQD/i4YA/4t/AP+KgwD/i34A/4mBAP+IewD/jIUA/4l+AP+HgwD/hoQA/4d8AP+MhAD/i38A/4uCAP+JfwD/i4IA/4aAAP+IgAD/iIQA/4l/AP+GggD/iIQA/4eDAP+JhgD/in8A/4qBAP+JgQD/iX8A/4l/AP+KegD/iX0A/4eCAP+JhQD/hn8A/4aAAP+HgAD/hoIA/4h/AP+MfQD/jYMA/42DAP+MfQD/iH8A/4aCAP+HgAD/hoAA/4Z/AP+JhQD/h4IA/4l9AP+KegD/iX8A/4l/AP+JgQD/ioEA/4p/AP+JhgD/h4MA/4iEAP+GggD/iX8A/4iEAP+IgAD/hoAA/4uCAP+JfwD/i4IA/4t/AP+MhAD/h3wA/4aEAP+HgwD/iX4A/4yFAP+IewD/iYEA/4t+AP+KgwD/i38A/4uGAP+GfQD/hn8A/4R+AP+EgwD/hIEA/4SCAP+DggD/h4EA/4KDAP+CfQD/g3wA/4F/AP+BgAD/gH8A/4F+AP+BggD/gH4A/39+AP+BfgD/goIA/4OBAP+AgwD/gYIA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AggD/gIIA/4KEAP+AgQD/gX4A/4KEAP+CfgD/gYIA/4F8AP+AfQD/goUA/4CCAP+AfwD/hIMA/4WCAP+GgAD/hoAA/4V/AP+FfgD/hX4A/4Z/AP+HfwD/ioAA/4mBAP+JfQD/iYEA/4qEAP+LgwD/iX8A/4yBAP+JgQD/iYQA/4aCAP+GfgD/ioIA/4t+AP+JgwD/i4UA/4+FAP+MgQD/joAA/4iAAP+JhgD/hn8A/4aDAP+JgwD/i4IA/42FAP+MggD/i4IA/4mBAP+GgAD/iYYA/4aBAP+EfQD/iHoA/4Z9AP+GhQD/hoEA/4d9AP+LhAD/in4A/4yDAP+MgwD/in4A/4uEAP+HfQD/hoEA/4aFAP+GfQD/iHoA/4R9AP+GgQD/iYYA/4aAAP+JgQD/i4IA/4yCAP+NhQD/i4IA/4mDAP+GgwD/hn8A/4mGAP+IgAD/joAA/4yBAP+PhQD/i4UA/4mDAP+LfgD/ioIA/4Z+AP+GggD/iYQA/4mBAP+MgQD/iX8A/4uDAP+KhAD/iYEA/4l9AP+JgQD/ioAA/4d/AP+GfwD/hX4A/4V+AP+FfwD/hoAA/4aAAP+FggD/hIMA/4B/AP+AggD/goUA/4B9AP+BfAD/gYIA/4J+AP+ChAD/gX4A/4CBAP+ChAD/gIIA/4CCAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4B/AP+AfgD/fX8A/39+AP+AfgD/gIMA/35/AP+AfwD/gIEA/4GBAP+BgAD/hIIA/4SCAP+FgQD/g30A/4R9AP+GfwD/h4AA/4iCAP+GfQD/ioAA/4qCAP+JfwD/h34A/4Z8AP+LhQD/jH4A/418AP+LfAD/i38A/4Z7AP+GgAD/iYIA/4yDAP+NgAD/kIQA/5CGAP+NfQD/joMA/5B/AP+NfgD/ioYA/4uAAP+IewD/i4UA/4l+AP+JfwD/iYEA/4mCAP+GfQD/h4EA/4uAAP+HhAD/iYIA/4x6AP+LfgD/iHwA/4iAAP+KgAD/iH4A/4x9AP+LgwD/i4MA/4x9AP+IfgD/ioAA/4iAAP+IfAD/i34A/4x6AP+JggD/h4QA/4uAAP+HgQD/hn0A/4mCAP+JgQD/iX8A/4l+AP+LhQD/iHsA/4uAAP+KhgD/jX4A/5B/AP+OgwD/jX0A/5CGAP+QhAD/jYAA/4yDAP+JggD/hoAA/4Z7AP+LfwD/i3wA/418AP+MfgD/i4UA/4Z8AP+HfgD/iX8A/4qCAP+KgAD/hn0A/4iCAP+HgAD/hn8A/4R9AP+DfQD/hYEA/4SCAP+EggD/gYAA/4GBAP+AgQD/gH8A/35/AP+AgwD/gH4A/39+AP99fwD/gH4A/4B/AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gH4A/4B+AP+BfQD/goIA/4B9AP9/ggD/goMA/4F+AP+BggD/gIIA/4SDAP+CgAD/g4cA/4WDAP+HfwD/hoIA/4R+AP+EgAD/hX0A/4h/AP+KfgD/i4YA/4mBAP+JfwD/iYMA/4l/AP+KggD/jH4A/4yEAP+MfQD/jH4A/4uBAP+IfwD/iX0A/4qBAP+NfgD/kIIA/45+AP+PggD/kIEA/416AP+OhgD/jnwA/41/AP+LgQD/ioUA/4l/AP+LfAD/i4MA/4d+AP+JgQD/iIUA/4uCAP+KfwD/iYAA/4mCAP+KfgD/iYIA/4qFAP+HfQD/iIEA/4x/AP+MfwD/iIIA/4iCAP+MfwD/jH8A/4iBAP+HfQD/ioUA/4mCAP+KfgD/iYIA/4mAAP+KfwD/i4IA/4iFAP+JgQD/h34A/4uDAP+LfAD/iX8A/4qFAP+LgQD/jX8A/458AP+OhgD/jXoA/5CBAP+PggD/jn4A/5CCAP+NfgD/ioEA/4l9AP+IfwD/i4EA/4x+AP+MfQD/jIQA/4x+AP+KggD/iX8A/4mDAP+JfwD/iYEA/4uGAP+KfgD/iH8A/4V9AP+EgAD/hH4A/4aCAP+HfwD/hYMA/4OHAP+CgAD/hIMA/4CCAP+BggD/gX4A/4KDAP9/ggD/gH0A/4KCAP+BfQD/gH4A/4B+AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9+fQD/foEA/4GDAP+CgQD/gIIA/4B+AP+AfQD/goEA/4N9AP+EgQD/gYIA/358AP+CgwD/gn0A/4KCAP+DfwD/hX0A/4V/AP+FggD/h3oA/4aBAP+EgQD/iIEA/4eBAP+GfgD/iX8A/4t/AP+JfQD/h34A/4l/AP+KhAD/iYIA/42CAP+NgAD/joAA/45/AP+NhQD/jH0A/4yCAP+MfwD/j4AA/5J/AP+QfAD/joEA/41+AP+JgAD/jYAA/415AP+NfQD/jIIA/4mCAP+KfQD/i4EA/4t9AP+KggD/ioUA/4V+AP+LfAD/iH4A/4p9AP+IgwD/iHwA/4iCAP+KgAD/h4QA/4qGAP+KfQD/i4AA/4iHAP+IhwD/i4AA/4p9AP+KhgD/h4QA/4qAAP+IggD/iHwA/4iDAP+KfQD/iH4A/4t8AP+FfgD/ioUA/4qCAP+LfQD/i4EA/4p9AP+JggD/jIIA/419AP+NeQD/jYAA/4mAAP+NfgD/joEA/5B8AP+SfwD/j4AA/4x/AP+MggD/jH0A/42FAP+OfwD/joAA/42AAP+NggD/iYIA/4qEAP+JfwD/h34A/4l9AP+LfwD/iX8A/4Z+AP+HgQD/iIEA/4SBAP+GgQD/h3oA/4WCAP+FfwD/hX0A/4N/AP+CggD/gn0A/4KDAP9+fAD/gYIA/4SBAP+DfQD/goEA/4B9AP+AfgD/gIIA/4KBAP+BgwD/foEA/359AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfwD/foAA/39+AP+AfwD/gYIA/4GCAP+AfQD/gH8A/35/AP9+fQD/g4AA/4OCAP9/gAD/goQA/4J/AP+DggD/hX0A/4eFAP+FfgD/hoIA/4aBAP+HgAD/hoUA/4Z+AP+KgQD/hn0A/4mAAP+KgwD/iYEA/4Z8AP+KggD/iYIA/46AAP+PgwD/kIAA/49/AP+NfAD/jX8A/46DAP+LgAD/jX8A/4yBAP+OfwD/kIAA/4x/AP+NfwD/jYAA/4yCAP+MfwD/ioEA/42AAP+MgQD/joMA/42GAP+MfQD/jIAA/4uEAP+LgwD/in8A/4uBAP+JeQD/iIAA/4mEAP+LfQD/iooA/4mEAP+IegD/i4gA/4h7AP+IfQD/iH0A/4h7AP+LiAD/iHoA/4mEAP+KigD/i30A/4mEAP+IgAD/iXkA/4uBAP+KfwD/i4MA/4uEAP+MgAD/jH0A/42GAP+OgwD/jIEA/42AAP+KgQD/jH8A/4yCAP+NgAD/jX8A/4x/AP+QgAD/jn8A/4yBAP+NfwD/i4AA/46DAP+NfwD/jXwA/49/AP+QgAD/j4MA/46AAP+JggD/ioIA/4Z8AP+JgQD/ioMA/4mAAP+GfQD/ioEA/4Z+AP+GhQD/h4AA/4aBAP+GggD/hX4A/4eFAP+FfQD/g4IA/4J/AP+ChAD/f4AA/4OCAP+DgAD/fn0A/35/AP+AfwD/gH0A/4GCAP+BggD/gH8A/39+AP9+gAD/gH8A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/fn0A/3+CAP9/gAD/gIAA/398AP+AfgD/f30A/359AP9/gwD/gH8A/4GAAP+CfgD/gn4A/4KAAP+FgQD/g4EA/4OCAP+IggD/h4MA/4WAAP+GfwD/hoAA/4Z+AP+IfQD/iYEA/4h/AP+IfgD/i34A/4qEAP+LhQD/jH4A/42CAP+PgwD/kH0A/5CAAP+OgQD/i3oA/42GAP+RgQD/i30A/4yAAP+NgwD/in0A/4t8AP+OfgD/j34A/499AP+PhQD/in4A/46AAP+OggD/i30A/45+AP+SfgD/jIAA/42DAP+JeQD/iH8A/4uFAP+MhgD/jX8A/4p8AP+IgAD/jH8A/4p+AP+HggD/i38A/4qFAP+HfQD/iYEA/4mBAP+HfQD/ioUA/4t/AP+HggD/in4A/4x/AP+IgAD/inwA/41/AP+MhgD/i4UA/4h/AP+JeQD/jYMA/4yAAP+SfgD/jn4A/4t9AP+OggD/joAA/4p+AP+PhQD/j30A/49+AP+OfgD/i3wA/4p9AP+NgwD/jIAA/4t9AP+RgQD/jYYA/4t6AP+OgQD/kIAA/5B9AP+PgwD/jYIA/4x+AP+LhQD/ioQA/4t+AP+IfgD/iH8A/4mBAP+IfQD/hn4A/4aAAP+GfwD/hYAA/4eDAP+IggD/g4IA/4OBAP+FgQD/goAA/4J+AP+CfgD/gYAA/4B/AP9/gwD/fn0A/399AP+AfgD/f3wA/4CAAP9/gAD/f4IA/359AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/f30A/36BAP+AfgD/fYEA/32CAP+BhAD/gYIA/4GAAP+AgAD/f30A/397AP+AhQD/f38A/4OEAP+DggD/hYAA/4aCAP+FggD/hX8A/4d/AP+GfQD/hX4A/4aAAP+IfQD/iYIA/4qCAP+JgQD/i4AA/4mBAP+LgwD/jH4A/4yEAP+NgAD/kIAA/5CAAP+PggD/jYAA/4uCAP+NhAD/i3wA/4p8AP+NhAD/i4AA/4uGAP+NewD/jX0A/419AP+OfgD/jYUA/4x+AP+OfgD/jX4A/46BAP+NfgD/joUA/42HAP+NfQD/joMA/4t6AP+MggD/jIIA/41/AP+JfwD/iYMA/417AP+JewD/hn8A/4l9AP+LgQD/iYIA/4eAAP+HgAD/iYIA/4uBAP+JfQD/hn8A/4l7AP+NewD/iYMA/4l/AP+NfwD/jIIA/4yCAP+LegD/joMA/419AP+NhwD/joUA/41+AP+OgQD/jX4A/45+AP+MfgD/jYUA/45+AP+NfQD/jX0A/417AP+LhgD/i4AA/42EAP+KfAD/i3wA/42EAP+LggD/jYAA/4+CAP+QgAD/kIAA/42AAP+MhAD/jH4A/4uDAP+JgQD/i4AA/4mBAP+KggD/iYIA/4h9AP+GgAD/hX4A/4Z9AP+HfwD/hX8A/4WCAP+GggD/hYAA/4OCAP+DhAD/f38A/4CFAP9/ewD/f30A/4CAAP+BgAD/gYIA/4GEAP99ggD/fYEA/4B+AP9+gQD/f30A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gH8A/35+AP9+gwD/fHwA/3yAAP9/fgD/f4IA/39+AP+AfgD/gIUA/4OBAP+CgwD/gH0A/4J+AP+CgAD/goAA/4aBAP+FegD/h4MA/4V8AP+GfQD/hnsA/4KBAP+GfgD/hn8A/4Z+AP+IfwD/h4UA/4h/AP+IewD/iX8A/418AP+MfQD/joAA/49/AP+OgQD/jYAA/4x/AP+MfQD/joAA/4x+AP+LeQD/jYYA/4t/AP+MgAD/j4EA/4+CAP+OggD/joEA/46AAP+RfwD/joMA/42CAP+NgAD/i4AA/4p9AP+NgQD/j4EA/4p6AP+MhAD/ioAA/4t/AP+PggD/jYQA/4mAAP+MgQD/iX4A/4mCAP+JfQD/iIQA/4h/AP+KhAD/ioQA/4h/AP+IhAD/iX0A/4mCAP+JfgD/jIEA/4mAAP+NhAD/j4IA/4t/AP+KgAD/jIQA/4p6AP+PgQD/jYEA/4p9AP+LgAD/jYAA/42CAP+OgwD/kX8A/46AAP+OgQD/joIA/4+CAP+PgQD/jIAA/4t/AP+NhgD/i3kA/4x+AP+OgAD/jH0A/4x/AP+NgAD/joEA/49/AP+OgAD/jH0A/418AP+JfwD/iHsA/4h/AP+HhQD/iH8A/4Z+AP+GfwD/hn4A/4KBAP+GewD/hn0A/4V8AP+HgwD/hXoA/4aBAP+CgAD/goAA/4J+AP+AfQD/goMA/4OBAP+AhQD/gH4A/39+AP9/ggD/f34A/3yAAP98fAD/foMA/35+AP+AfwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/35+AP98ggD/f4MA/319AP99gAD/fIEA/3+AAP+AfwD/goAA/4F/AP+ChQD/hIIA/4F+AP+EgQD/hIIA/4eDAP+GgwD/h4IA/4OBAP+FfgD/hH0A/4SAAP+CggD/gX8A/4OEAP+IgQD/h4AA/4qEAP+IhQD/jIUA/4yBAP+LfAD/jH4A/45/AP+NfAD/i3oA/4uCAP+MfQD/kH4A/42DAP+OgQD/jX8A/42DAP+OggD/jXwA/5B/AP+SgAD/kIIA/5CAAP+SfwD/kHwA/416AP+KggD/in4A/4d+AP+JgAD/jX4A/5CFAP+NgQD/jIQA/4qBAP+LewD/i4EA/4iDAP+JfgD/iXkA/4x+AP+JggD/ioEA/4uEAP+LgwD/i3wA/4t8AP+LgwD/i4QA/4qBAP+JggD/jH4A/4l5AP+JfgD/iIMA/4uBAP+LewD/ioEA/4yEAP+NgQD/kIUA/41+AP+JgAD/h34A/4p+AP+KggD/jXoA/5B8AP+SfwD/kIAA/5CCAP+SgAD/kH8A/418AP+OggD/jYMA/41/AP+OgQD/jYMA/5B+AP+MfQD/i4IA/4t6AP+NfAD/jn8A/4x+AP+LfAD/jIEA/4yFAP+IhQD/ioQA/4eAAP+IgQD/g4QA/4F/AP+CggD/hIAA/4R9AP+FfgD/g4EA/4eCAP+GgwD/h4MA/4SCAP+EgQD/gX4A/4SCAP+ChQD/gX8A/4KAAP+AfwD/f4AA/3yBAP99gAD/fX0A/3+DAP98ggD/fn4A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP99fQD/fYIA/4GDAP9/fQD/foIA/3+AAP+AfQD/gYEA/4F8AP9/fgD/gYUA/4B+AP9+ggD/goAA/4R+AP+GhAD/hXoA/4aAAP+FgAD/iH8A/4OBAP+CfgD/h3sA/4KBAP+HgwD/h4UA/4V8AP+HgAD/h38A/4l+AP+JgQD/i38A/4uBAP+NhQD/jX8A/42GAP+NhAD/joAA/42DAP+GhQD/ioUA/42CAP+NgAD/jYIA/49/AP+SfwD/kIQA/4+EAP+SfwD/knsA/5OCAP+NfgD/i34A/4qAAP+JfgD/ioAA/458AP+PgwD/jn4A/4p/AP+KgQD/in0A/4p+AP+KfgD/jYYA/4uCAP+QfgD/in8A/4mIAP+KgAD/jIMA/4x+AP+MfgD/jIMA/4qAAP+JiAD/in8A/5B+AP+LggD/jYYA/4p+AP+KfgD/in0A/4qBAP+KfwD/jn4A/4+DAP+OfAD/ioAA/4l+AP+KgAD/i34A/41+AP+TggD/knsA/5J/AP+PhAD/kIQA/5J/AP+PfwD/jYIA/42AAP+NggD/ioUA/4aFAP+NgwD/joAA/42EAP+NhgD/jX8A/42FAP+LgQD/i38A/4mBAP+JfgD/h38A/4eAAP+FfAD/h4UA/4eDAP+CgQD/h3sA/4J+AP+DgQD/iH8A/4WAAP+GgAD/hXoA/4aEAP+EfgD/goAA/36CAP+AfgD/gYUA/39+AP+BfAD/gYEA/4B9AP9/gAD/foIA/399AP+BgwD/fYIA/319AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfwD/fYAA/36BAP99fgD/fn0A/4CEAP9/gAD/gn4A/4B+AP+BgAD/gIMA/4CBAP+CgQD/gX4A/4SCAP+CfgD/hYEA/4OGAP+DgAD/hoAA/4aBAP+GggD/hoAA/4Z/AP+FggD/hX4A/4mCAP+JgQD/iYIA/4iCAP+HgwD/iYQA/4Z7AP+IfwD/jH0A/46DAP+RgQD/i3wA/4x+AP+OgQD/ioUA/4mEAP+KfQD/kIMA/42BAP+NfwD/joMA/4+AAP+RggD/lIEA/5KCAP+RgQD/joAA/46GAP+NfgD/jH8A/4p/AP+MewD/jH0A/498AP+LgQD/h4AA/4h9AP+JgAD/jYIA/5F/AP+OgQD/jYEA/4t9AP+LfgD/in8A/46DAP+PfgD/j34A/46DAP+KfwD/i34A/4t9AP+NgQD/joEA/5F/AP+NggD/iYAA/4h9AP+HgAD/i4EA/498AP+MfQD/jHsA/4p/AP+MfwD/jX4A/46GAP+OgAD/kYEA/5KCAP+UgQD/kYIA/4+AAP+OgwD/jX8A/42BAP+QgwD/in0A/4mEAP+KhQD/joEA/4x+AP+LfAD/kYEA/46DAP+MfQD/iH8A/4Z7AP+JhAD/h4MA/4iCAP+JggD/iYEA/4mCAP+FfgD/hYIA/4Z/AP+GgAD/hoIA/4aBAP+GgAD/g4AA/4OGAP+FgQD/gn4A/4SCAP+BfgD/goEA/4CBAP+AgwD/gYAA/4B+AP+CfgD/f4AA/4CEAP9+fQD/fX4A/36BAP99gAD/gH8A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+BgQD/fn0A/4GEAP9+fgD/foQA/4F+AP+AfgD/gH8A/4GCAP+CfwD/gX4A/4N/AP+DhAD/g4MA/4SFAP+DfgD/hIMA/4aDAP+CgAD/hIIA/4R9AP+AfQD/h38A/4V/AP+GgAD/hYUA/4iCAP+JgQD/iX4A/4uAAP+LhQD/hoQA/4aCAP+GgAD/iX0A/4yCAP+LgAD/i30A/4p8AP+LeQD/jX8A/42CAP+KfQD/iYQA/4x/AP+MfwD/jX8A/4yBAP+PgQD/kn0A/5ODAP+NfQD/j4AA/5B9AP+QfgD/kYIA/4t+AP+NhgD/i34A/4yDAP+MggD/iH0A/4qDAP+NgAD/jn0A/46CAP+NggD/joIA/41+AP+NgQD/jIMA/4uGAP+LgwD/jIMA/4yDAP+LgwD/i4YA/4yDAP+NgQD/jX4A/46CAP+NggD/joIA/459AP+NgAD/ioMA/4h9AP+MggD/jIMA/4t+AP+NhgD/i34A/5GCAP+QfgD/kH0A/4+AAP+NfQD/k4MA/5J9AP+PgQD/jIEA/41/AP+MfwD/jH8A/4mEAP+KfQD/jYIA/41/AP+LeQD/inwA/4t9AP+LgAD/jIIA/4l9AP+GgAD/hoIA/4aEAP+LhQD/i4AA/4l+AP+JgQD/iIIA/4WFAP+GgAD/hX8A/4d/AP+AfQD/hH0A/4SCAP+CgAD/hoMA/4SDAP+DfgD/hIUA/4ODAP+DhAD/g38A/4F+AP+CfwD/gYIA/4B/AP+AfgD/gX4A/36EAP9+fgD/gYQA/359AP+BgQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AggD/goAA/4F/AP+CfQD/f4AA/4CCAP+AgAD/gIAA/4CBAP+CgwD/gX4A/4GEAP+EfwD/goIA/4OGAP+FgwD/g4AA/4SEAP+FewD/gnwA/4aCAP+GfAD/hX8A/4OCAP+EgwD/hn4A/4mBAP+KfgD/h3sA/4uJAP+HgAD/in0A/4d8AP+GfgD/iYIA/4qBAP+MfwD/jX8A/4yAAP+NhAD/jYYA/42DAP+NgAD/kIMA/4x/AP+OhAD/joQA/499AP+PggD/kH8A/5KDAP+UgQD/j4AA/498AP+PfgD/j38A/5R+AP+KgwD/jn8A/4yEAP+JfgD/iX4A/41/AP+OfQD/i3wA/5GDAP+OgQD/kH8A/49+AP+PgwD/jn4A/46BAP+PgQD/jYIA/4uDAP+LgwD/jYIA/4+BAP+OgQD/jn4A/4+DAP+PfgD/kH8A/46BAP+RgwD/i3wA/459AP+NfwD/iX4A/4l+AP+MhAD/jn8A/4qDAP+UfgD/j38A/49+AP+PfAD/j4AA/5SBAP+SgwD/kH8A/4+CAP+PfQD/joQA/46EAP+MfwD/kIMA/42AAP+NgwD/jYYA/42EAP+MgAD/jX8A/4x/AP+KgQD/iYIA/4Z+AP+HfAD/in0A/4eAAP+LiQD/h3sA/4p+AP+JgQD/hn4A/4SDAP+DggD/hX8A/4Z8AP+GggD/gnwA/4V7AP+EhAD/g4AA/4WDAP+DhgD/goIA/4R/AP+BhAD/gX4A/4KDAP+AgQD/gIAA/4CAAP+AggD/f4AA/4J9AP+BfwD/goAA/4CCAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/g4IA/4F9AP+BgQD/f3wA/3+AAP99fwD/f34A/4GAAP+CfwD/gX4A/4F/AP+BfQD/g4AA/4J/AP+FhQD/hX8A/4V+AP+EfwD/g4AA/4Z+AP+HfgD/gnwA/4d/AP+GggD/iYcA/4mEAP+IhAD/hnwA/4l3AP+GjgD/h34A/4uAAP+MhAD/ioIA/4yDAP+NfgD/j4AA/4yBAP+NgwD/i4AA/4t/AP+OggD/jYIA/42BAP+MfwD/joQA/5GCAP+RfwD/jn4A/4+BAP+VhQD/lIIA/5GEAP+QfgD/j4MA/46BAP+SgwD/kH4A/4+AAP+MgAD/i30A/4p/AP+MgAD/i3oA/4mAAP+PfwD/kIMA/457AP+SgAD/koIA/5GAAP+SgwD/kIAA/5F/AP+PfgD/j34A/5F/AP+QgAD/koMA/5GAAP+SggD/koAA/457AP+QgwD/j38A/4mAAP+LegD/jIAA/4p/AP+LfQD/jIAA/4+AAP+QfgD/koMA/46BAP+PgwD/kH4A/5GEAP+UggD/lYUA/4+BAP+OfgD/kX8A/5GCAP+OhAD/jH8A/42BAP+NggD/joIA/4t/AP+LgAD/jYMA/4yBAP+PgAD/jX4A/4yDAP+KggD/jIQA/4uAAP+HfgD/ho4A/4l3AP+GfAD/iIQA/4mEAP+JhwD/hoIA/4d/AP+CfAD/h34A/4Z+AP+DgAD/hH8A/4V+AP+FfwD/hYUA/4J/AP+DgAD/gX0A/4F/AP+BfgD/gn8A/4GAAP9/fgD/fX8A/3+AAP9/fAD/gYEA/4F9AP+DggD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIIA/4F8AP+BggD/goAA/4F/AP+BfgD/gYIA/4B9AP9/gQD/f4AA/4GCAP+CgAD/gYAA/4SAAP+FgwD/hoUA/4N9AP+GgAD/hYAA/4R+AP+GgQD/hnsA/4WCAP+IgwD/iYIA/4t/AP+KggD/iX8A/4eDAP+IfgD/h34A/4qEAP+LgwD/i38A/4t+AP+NgAD/kIIA/5J/AP+OfwD/in0A/4uGAP+MgAD/jXwA/49/AP+NfwD/jX8A/499AP+RfwD/kn4A/49/AP+RigD/koIA/5F/AP+QewD/iX0A/459AP+OfwD/kIEA/4yFAP+LfAD/joIA/4x+AP+NhAD/i34A/4x/AP+NggD/joUA/5B/AP+SfwD/lHwA/5aDAP+TggD/jn4A/5B+AP+PfgD/k3wA/5N8AP+PfgD/kH4A/45+AP+TggD/loMA/5R8AP+SfwD/kH8A/46FAP+NggD/jH8A/4t+AP+NhAD/jH4A/46CAP+LfAD/jIUA/5CBAP+OfwD/jn0A/4l9AP+QewD/kX8A/5KCAP+RigD/j38A/5J+AP+RfwD/j30A/41/AP+NfwD/j38A/418AP+MgAD/i4YA/4p9AP+OfwD/kn8A/5CCAP+NgAD/i34A/4t/AP+LgwD/ioQA/4d+AP+IfgD/h4MA/4l/AP+KggD/i38A/4mCAP+IgwD/hYIA/4Z7AP+GgQD/hH4A/4WAAP+GgAD/g30A/4aFAP+FgwD/hIAA/4GAAP+CgAD/gYIA/3+AAP9/gQD/gH0A/4GCAP+BfgD/gX8A/4KAAP+BggD/gXwA/4CCAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9/fQD/foEA/4KCAP9+fwD/gIEA/4GDAP+AfwD/goYA/4KCAP+BfwD/gXwA/4CBAP9/fgD/gn8A/4OAAP+JfwD/hoIA/4Z7AP+FgwD/hIEA/4R+AP+DfAD/hH4A/4aBAP+GhgD/hnwA/4l6AP+JhQD/jn0A/45+AP+IfQD/h30A/4aDAP+HggD/iX4A/4uCAP+JgwD/kIQA/45+AP+QfAD/kIAA/4t8AP+NewD/j4EA/5B/AP+SfwD/joMA/4yBAP+PggD/jn4A/49/AP+QhQD/kIAA/5B9AP+PegD/j4AA/4yAAP+OigD/iYEA/41/AP+LfQD/joMA/4l8AP+KfwD/iH8A/4p/AP+OgwD/koUA/5SAAP+SgQD/lYIA/5OBAP+WfwD/lX8A/49+AP+QfgD/kn8A/5WCAP+VggD/kn8A/5B+AP+PfgD/lX8A/5Z/AP+TgQD/lYIA/5KBAP+UgAD/koUA/46DAP+KfwD/iH8A/4p/AP+JfAD/joMA/4t9AP+NfwD/iYEA/46KAP+MgAD/j4AA/496AP+QfQD/kIAA/5CFAP+PfwD/jn4A/4+CAP+MgQD/joMA/5J/AP+QfwD/j4EA/417AP+LfAD/kIAA/5B8AP+OfgD/kIQA/4mDAP+LggD/iX4A/4eCAP+GgwD/h30A/4h9AP+OfgD/jn0A/4mFAP+JegD/hnwA/4aGAP+GgQD/hH4A/4N8AP+EfgD/hIEA/4WDAP+GewD/hoIA/4l/AP+DgAD/gn8A/39+AP+AgQD/gXwA/4F/AP+CggD/goYA/4B/AP+BgwD/gIEA/35/AP+CggD/foEA/399AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/foEA/4CFAP+AgQD/gH8A/4GFAP+CgQD/gX8A/4SEAP+EgQD/hX8A/4F/AP+BfgD/gH4A/4WEAP+BggD/g4AA/4SBAP+GiAD/iIEA/4Z7AP+EfQD/hX0A/4V+AP+GggD/hYAA/4eHAP+IggD/i4MA/4uCAP+KgQD/iX4A/4h+AP+HgAD/iYUA/4qCAP+JfwD/i4UA/5CGAP+PggD/joEA/4x/AP+OfgD/jX0A/4+CAP+SgAD/kIQA/4+AAP+PgQD/kH8A/4+BAP+RigD/kIAA/5SKAP+RgQD/kYEA/4+AAP+OgAD/jYIA/4uCAP+JfgD/jIIA/4qAAP+KgAD/i4EA/4yDAP+NfgD/kYEA/5R/AP+TfgD/lIMA/5V+AP+UgAD/kn8A/5N+AP+QfgD/lIIA/5J8AP+XggD/l4IA/5J8AP+UggD/kH4A/5N+AP+SfwD/lIAA/5V+AP+UgwD/k34A/5R/AP+RgQD/jX4A/4yDAP+LgQD/ioAA/4qAAP+MggD/iX4A/4uCAP+NggD/joAA/4+AAP+RgQD/kYEA/5SKAP+QgAD/kYoA/4+BAP+QfwD/j4EA/4+AAP+QhAD/koAA/4+CAP+NfQD/jn4A/4x/AP+OgQD/j4IA/5CGAP+LhQD/iX8A/4qCAP+JhQD/h4AA/4h+AP+JfgD/ioEA/4uCAP+LgwD/iIIA/4eHAP+FgAD/hoIA/4V+AP+FfQD/hH0A/4Z7AP+IgQD/hogA/4SBAP+DgAD/gYIA/4WEAP+AfgD/gX4A/4F/AP+FfwD/hIEA/4SEAP+BfwD/goEA/4GFAP+AfwD/gIEA/4CFAP9+gQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gH4A/4CCAP+CgQD/gH8A/3+AAP+AfgD/goMA/4KDAP+BfgD/hIEA/4SDAP+AfgD/f4EA/4OFAP+FdwD/gHsA/4KIAP+FfgD/h38A/4d+AP+HegD/hH0A/4WAAP+GfgD/hoAA/4V+AP+GggD/iIMA/4mCAP+JgQD/h30A/4eGAP+KhQD/h3kA/4uBAP+NfQD/i4IA/4+FAP+NfQD/kIEA/41+AP+NfwD/j34A/419AP+OggD/kIIA/4+EAP+RggD/kn0A/5KDAP+VhQD/koIA/5B9AP+RgQD/kX4A/5J/AP+RgQD/jn8A/4t+AP+IgQD/h34A/4qBAP+LgQD/in0A/458AP+OggD/jnsA/5F6AP+RggD/kn0A/5GAAP+PfAD/jnoA/4yAAP+SggD/j38A/5B8AP+ShwD/mHsA/5h7AP+ShwD/kHwA/49/AP+SggD/jIAA/456AP+PfAD/kYAA/5J9AP+RggD/kXoA/457AP+OggD/jnwA/4p9AP+LgQD/ioEA/4d+AP+IgQD/i34A/45/AP+RgQD/kn8A/5F+AP+RgQD/kH0A/5KCAP+VhQD/koMA/5J9AP+RggD/j4QA/5CCAP+OggD/jX0A/49+AP+NfwD/jX4A/5CBAP+NfQD/j4UA/4uCAP+NfQD/i4EA/4d5AP+KhQD/h4YA/4d9AP+JgQD/iYIA/4iDAP+GggD/hX4A/4aAAP+GfgD/hYAA/4R9AP+HegD/h34A/4d/AP+FfgD/gogA/4B7AP+FdwD/g4UA/3+BAP+AfgD/hIMA/4SBAP+BfgD/goMA/4KDAP+AfgD/f4AA/4B/AP+CgQD/gIIA/4B+AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/31+AP9+gQD/g4MA/4J/AP+BfwD/gIAA/4J/AP+CfgD/hIEA/4SCAP+DfwD/gH8A/36BAP+BggD/g4IA/4J9AP+HhAD/h4MA/4d/AP+IgwD/iX8A/4h+AP+EggD/g38A/4V6AP+GfwD/in4A/4eBAP+HfgD/iYEA/4Z8AP+LggD/in0A/4uAAP+KggD/iH0A/4aAAP+MgQD/joMA/416AP+JgAD/jYAA/499AP+OfgD/joEA/5CAAP+SfwD/lIEA/5ODAP+UgQD/lIIA/5F/AP+PegD/kYEA/5J/AP+RhgD/joIA/5CEAP+LfAD/i4MA/4uBAP+MhgD/jYIA/42CAP+MgAD/kX8A/5CCAP+UgwD/lIMA/5J8AP+TgAD/kYIA/5SDAP+QfgD/kIIA/42BAP+OggD/koAA/5F9AP+RfQD/koAA/46CAP+NgQD/kIIA/5B+AP+UgwD/kYIA/5OAAP+SfAD/lIMA/5SDAP+QggD/kX8A/4yAAP+NggD/jYIA/4yGAP+LgQD/i4MA/4t8AP+QhAD/joIA/5GGAP+SfwD/kYEA/496AP+RfwD/lIIA/5SBAP+TgwD/lIEA/5J/AP+QgAD/joEA/45+AP+PfQD/jYAA/4mAAP+NegD/joMA/4yBAP+GgAD/iH0A/4qCAP+LgAD/in0A/4uCAP+GfAD/iYEA/4d+AP+HgQD/in4A/4Z/AP+FegD/g38A/4SCAP+IfgD/iX8A/4iDAP+HfwD/h4MA/4eEAP+CfQD/g4IA/4GCAP9+gQD/gH8A/4N/AP+EggD/hIEA/4J+AP+CfwD/gIAA/4F/AP+CfwD/g4MA/36BAP99fgD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/399AP99gAD/gIIA/39/AP+BhQD/gn4A/4GCAP+EgAD/g4IA/4WEAP+EgwD/g4AA/4KBAP+BfQD/gYAA/4aEAP+IggD/h38A/4eEAP+IfAD/iYQA/4uEAP+FfgD/iH0A/4eBAP+GggD/iH8A/4J9AP+FfwD/iYEA/4t/AP+IfwD/iYEA/4eBAP+IgQD/jIEA/4mCAP+IgAD/joAA/5B/AP+OhgD/jYAA/4yCAP+PhQD/jYUA/46AAP+SfwD/knsA/5KCAP+NfQD/j4AA/5GEAP+QewD/j4AA/4+AAP+RgQD/joIA/457AP+LhAD/jH8A/4t6AP+QgQD/joMA/5CAAP+PgQD/iYIA/49/AP+QgAD/kn8A/5SAAP+UggD/lYIA/5OFAP+PggD/j4IA/5ODAP+MgAD/kIIA/5KAAP+SgwD/koMA/5KAAP+QggD/jIAA/5ODAP+PggD/j4IA/5OFAP+VggD/lIIA/5SAAP+SfwD/kIAA/49/AP+JggD/j4EA/5CAAP+OgwD/kIEA/4t6AP+MfwD/i4QA/457AP+OggD/kYEA/4+AAP+PgAD/kHsA/5GEAP+PgAD/jX0A/5KCAP+SewD/kn8A/46AAP+NhQD/j4UA/4yCAP+NgAD/joYA/5B/AP+OgAD/iIAA/4mCAP+MgQD/iIEA/4eBAP+JgQD/iH8A/4t/AP+JgQD/hX8A/4J9AP+IfwD/hoIA/4eBAP+IfQD/hX4A/4uEAP+JhAD/iHwA/4eEAP+HfwD/iIIA/4aEAP+BgAD/gX0A/4KBAP+DgAD/hIMA/4WEAP+DggD/hIAA/4GCAP+CfgD/gYUA/39/AP+AggD/fYAA/399AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9+fAD/e4EA/4CDAP+AggD/gYAA/4KAAP+DggD/hIIA/4R9AP+CfgD/hYAA/4OAAP+FhAD/hXsA/4OBAP+GhgD/hHsA/4WAAP+FggD/hYQA/4V9AP+HgwD/hX4A/4eEAP+HgQD/h4QA/4l+AP+GfAD/iYUA/4yFAP+MggD/iH4A/4Z8AP+JggD/iXUA/4V/AP+GgQD/iIQA/4iAAP+NfgD/jnwA/415AP+MfwD/in4A/4x+AP+RfwD/kHwA/5OCAP+RgQD/j4AA/498AP+QfgD/iX0A/4yAAP+OgAD/jn8A/5CEAP+LhAD/i34A/5CAAP+QgQD/kIAA/4+CAP+JfgD/kIIA/5CDAP+RfgD/kYUA/5eDAP+ShAD/lIEA/5GBAP+ShwD/lH8A/5WGAP+ViQD/kHwA/5J+AP+QfgD/kIUA/5CFAP+QfgD/kn4A/5B8AP+ViQD/lYYA/5R/AP+ShwD/kYEA/5SBAP+ShAD/l4MA/5GFAP+RfgD/kIMA/5CCAP+JfgD/j4IA/5CAAP+QgQD/kIAA/4t+AP+LhAD/kIQA/45/AP+OgAD/jIAA/4l9AP+QfgD/j3wA/4+AAP+RgQD/k4IA/5B8AP+RfwD/jH4A/4p+AP+MfwD/jXkA/458AP+NfgD/iIAA/4iEAP+GgQD/hX8A/4l1AP+JggD/hnwA/4h+AP+MggD/jIUA/4mFAP+GfAD/iX4A/4eEAP+HgQD/h4QA/4V+AP+HgwD/hX0A/4WEAP+FggD/hYAA/4R7AP+GhgD/g4EA/4V7AP+FhAD/g4AA/4WAAP+CfgD/hH0A/4SCAP+DggD/goAA/4GAAP+AggD/gIMA/3uBAP9+fAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/fXwA/3uAAP9/gwD/f4AA/4GDAP+DfwD/g38A/4OBAP+CggD/goIA/4SCAP+DgQD/hH8A/4SCAP+EgAD/hoIA/4Z+AP+IfAD/hX0A/4h/AP+FgQD/hoMA/4aEAP+GegD/hYQA/4p/AP+LfwD/ioIA/4mCAP+HgQD/jHwA/4iFAP+GfgD/h4EA/4SBAP+HgAD/iX8A/4l/AP+JhgD/ioYA/41/AP+NfQD/ioEA/46AAP+OfgD/joMA/416AP+NfgD/joAA/5B9AP+PfgD/j4MA/459AP+OigD/jYIA/4t+AP+LfAD/jH8A/5CAAP+TewD/kX4A/5F8AP+NfAD/jYAA/42HAP+LegD/j4AA/5ODAP+PewD/lIEA/5WAAP+UhAD/k4IA/5aBAP+QgAD/k4YA/5B6AP+RhgD/jn0A/5N+AP+TfgD/jn0A/5GGAP+QegD/k4YA/5CAAP+WgQD/k4IA/5SEAP+VgAD/lIEA/497AP+TgwD/j4AA/4t6AP+NhwD/jYAA/418AP+RfAD/kX4A/5N7AP+QgAD/jH8A/4t8AP+LfgD/jYIA/46KAP+OfQD/j4MA/49+AP+QfQD/joAA/41+AP+NegD/joMA/45+AP+OgAD/ioEA/419AP+NfwD/ioYA/4mGAP+JfwD/iX8A/4eAAP+EgQD/h4EA/4Z+AP+IhQD/jHwA/4eBAP+JggD/ioIA/4t/AP+KfwD/hYQA/4Z6AP+GhAD/hoMA/4WBAP+IfwD/hX0A/4h8AP+GfgD/hoIA/4SAAP+EggD/hH8A/4OBAP+EggD/goIA/4KCAP+DgQD/g38A/4N/AP+BgwD/f4AA/3+DAP97gAD/fXwA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gH8A/3x8AP97gQD/foEA/36AAP+BgwD/goIA/4OBAP+CgAD/goUA/4SEAP+DfgD/hH8A/4WAAP+FfwD/hX0A/4aCAP+GgAD/ioAA/4t/AP+IgwD/h4UA/4eBAP+EfAD/h4QA/4iEAP+IgAD/hX8A/4l/AP+JgQD/in8A/4aBAP+KewD/h34A/4Z+AP+BewD/gn8A/4R+AP+GggD/hn8A/4uAAP+LgQD/jIIA/42AAP+OggD/jX4A/42CAP+KggD/i34A/46GAP+QfgD/j38A/46BAP+OfwD/iYEA/4uCAP+IgQD/i4MA/4t6AP+QgQD/kX4A/418AP+NfgD/kYMA/4+EAP+QgwD/jYAA/5F/AP+TgQD/k3sA/5N/AP+UfgD/lIIA/5N/AP+RfAD/kHkA/5N+AP+VfwD/k34A/5V/AP+SfgD/kn4A/5V/AP+TfgD/lX8A/5N+AP+QeQD/kXwA/5N/AP+UggD/lH4A/5N/AP+TewD/k4EA/5F/AP+NgAD/kIMA/4+EAP+RgwD/jX4A/418AP+RfgD/kIEA/4t6AP+LgwD/iIEA/4uCAP+JgQD/jn8A/46BAP+PfwD/kH4A/46GAP+LfgD/ioIA/42CAP+NfgD/joIA/42AAP+MggD/i4EA/4uAAP+GfwD/hoIA/4R+AP+CfwD/gXsA/4Z+AP+HfgD/insA/4aBAP+KfwD/iYEA/4l/AP+FfwD/iIAA/4iEAP+HhAD/hHwA/4eBAP+HhQD/iIMA/4t/AP+KgAD/hoAA/4aCAP+FfQD/hX8A/4WAAP+EfwD/g34A/4SEAP+ChQD/goAA/4OBAP+CggD/gYMA/36AAP9+gQD/e4EA/3x8AP+AfwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4B+AP97fQD/e4AA/32CAP9/ggD/gIIA/4GBAP+AgAD/goAA/4B9AP+DfwD/hYMA/4R/AP+EfgD/hX8A/4eDAP+HgwD/hX0A/4h/AP+LhAD/h4AA/4WAAP+HggD/h3gA/4Z+AP+EgAD/hnkA/4Z/AP+IhQD/hn8A/4Z/AP+IewD/jYQA/4iFAP+IggD/h3wA/4N8AP+EggD/iIQA/4aDAP+IewD/ioUA/4mCAP+MgQD/i30A/46BAP+NgAD/in4A/4qAAP+NfgD/kYIA/5R+AP+SgwD/kIEA/41/AP+JfgD/h34A/4uBAP+QgQD/kIAA/5F8AP+NfgD/kH0A/5J/AP+PeQD/koAA/45+AP+ShgD/kX4A/5OBAP+PfQD/kn4A/5OAAP+PegD/kYQA/458AP+SfQD/mH8A/5aCAP+UfAD/lYIA/5WCAP+UfAD/loIA/5h/AP+SfQD/jnwA/5GEAP+PegD/k4AA/5J+AP+PfQD/k4EA/5F+AP+ShgD/jn4A/5KAAP+PeQD/kn8A/5B9AP+NfgD/kXwA/5CAAP+QgQD/i4EA/4d+AP+JfgD/jX8A/5CBAP+SgwD/lH4A/5GCAP+NfgD/ioAA/4p+AP+NgAD/joEA/4t9AP+MgQD/iYIA/4qFAP+IewD/hoMA/4iEAP+EggD/g3wA/4d8AP+IggD/iIUA/42EAP+IewD/hn8A/4Z/AP+IhQD/hn8A/4Z5AP+EgAD/hn4A/4d4AP+HggD/hYAA/4eAAP+LhAD/iH8A/4V9AP+HgwD/h4MA/4V/AP+EfgD/hH8A/4WDAP+DfwD/gH0A/4KAAP+AgAD/gYEA/4CCAP9/ggD/fYIA/3uAAP97fQD/gH4A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9/fQD/e34A/3uAAP98gwD/f4AA/39/AP+BgwD/goEA/4OCAP+DggD/hYAA/4N/AP+GgwD/g30A/4SCAP+FhwD/hYIA/4aAAP+GhQD/iIAA/4iCAP+HggD/hIAA/4aDAP+HegD/iIEA/4mCAP+IfgD/hoMA/4WAAP+IggD/h4QA/4uEAP+HfQD/hXsA/4iAAP+HhgD/iH8A/4eDAP+JgwD/i4UA/4l/AP+KfQD/joMA/45+AP+NfgD/i4AA/4d+AP+JfgD/jH8A/4t+AP+KgwD/kH4A/4yFAP+LfQD/jIIA/4qBAP+MhgD/joMA/4+CAP+NfAD/kYMA/5J/AP+UgAD/kIIA/5SAAP+OgQD/koAA/5SEAP+TgAD/lIMA/5CBAP+SfgD/kH4A/5N+AP+TgQD/k4EA/5N8AP+WhQD/loIA/5aAAP+WgAD/loIA/5aFAP+TfAD/k4EA/5OBAP+TfgD/kH4A/5J+AP+QgQD/lIMA/5OAAP+UhAD/koAA/46BAP+UgAD/kIIA/5SAAP+SfwD/kYMA/418AP+PggD/joMA/4yGAP+KgQD/jIIA/4t9AP+MhQD/kH4A/4qDAP+LfgD/jH8A/4l+AP+HfgD/i4AA/41+AP+OfgD/joMA/4p9AP+JfwD/i4UA/4mDAP+HgwD/iH8A/4eGAP+IgAD/hXsA/4d9AP+LhAD/h4QA/4iCAP+FgAD/hoMA/4h+AP+JggD/iIEA/4d6AP+GgwD/hIAA/4eCAP+IggD/iIAA/4aFAP+GgAD/hYIA/4WHAP+EggD/g30A/4aDAP+DfwD/hYAA/4OCAP+DggD/goEA/4GDAP9/fwD/f4AA/3yDAP97gAD/e34A/399AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/fnwA/3t/AP97fwD/fIIA/3+BAP9/ggD/f4IA/4OAAP+FggD/hIIA/4WCAP+FgwD/hIAA/4OFAP+FhAD/hn4A/4N+AP+FfwD/hX8A/4eCAP+IggD/iX0A/4iEAP+IfgD/iH8A/4Z/AP+KhAD/iH4A/4Z+AP+DewD/iYQA/4Z8AP+KhgD/jIAA/4d/AP+FgAD/iIMA/4l/AP+JhgD/i4IA/4l+AP+LfAD/i4EA/42GAP+SfgD/joUA/4p9AP+JgAD/ioAA/4p/AP+NhgD/jn8A/4+AAP+LfAD/joMA/4qAAP+LgQD/jYIA/5CAAP+JfgD/jYAA/4+EAP+PeQD/kIIA/4yKAP+PhQD/kH4A/5GAAP+ShgD/koUA/456AP+OgAD/kHsA/5KDAP+PfgD/kX0A/46CAP+ThwD/k30A/5Z/AP+aggD/moIA/5Z/AP+TfQD/k4cA/46CAP+RfQD/j34A/5KDAP+QewD/joAA/456AP+ShQD/koYA/5GAAP+QfgD/j4UA/4yKAP+QggD/j3kA/4+EAP+NgAD/iX4A/5CAAP+NggD/i4EA/4qAAP+OgwD/i3wA/4+AAP+OfwD/jYYA/4p/AP+KgAD/iYAA/4p9AP+OhQD/kn4A/42GAP+LgQD/i3wA/4l+AP+LggD/iYYA/4l/AP+IgwD/hYAA/4d/AP+MgAD/ioYA/4Z8AP+JhAD/g3sA/4Z+AP+IfgD/ioQA/4Z/AP+IfwD/iH4A/4iEAP+JfQD/iIIA/4eCAP+FfwD/hX8A/4N+AP+GfgD/hYQA/4OFAP+EgAD/hYMA/4WCAP+EggD/hYIA/4OAAP9/ggD/f4IA/3+BAP98ggD/e38A/3t/AP9+fAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/318AP96fwD/e4IA/3yAAP9+hAD/f38A/35/AP+CggD/g4EA/4OAAP+FgAD/hIAA/4J7AP+DhAD/gYIA/4SCAP+FhAD/hHwA/4aAAP+GhAD/hn4A/4mAAP+IfgD/iIAA/4Z+AP+HgQD/iIAA/4eCAP+HgAD/hoIA/4R8AP+IhAD/h4AA/4mBAP+LfQD/iYMA/4qGAP+LggD/in8A/42FAP+JfwD/i4MA/4t9AP+MfQD/jIAA/42HAP+NgQD/jX4A/458AP+MewD/i34A/4yEAP+MgAD/joIA/4l8AP+KgAD/in0A/42CAP+PgQD/kIIA/42HAP+QgwD/koAA/5SAAP+PhQD/j4EA/5CCAP+RggD/koUA/5J/AP+PfQD/jYEA/49/AP+RgAD/kYIA/5F5AP+VgwD/lnoA/5SDAP+UeQD/loEA/5aBAP+UeQD/lIMA/5Z6AP+VgwD/kXkA/5GCAP+RgAD/j38A/42BAP+PfQD/kn8A/5KFAP+RggD/kIIA/4+BAP+PhQD/lIAA/5KAAP+QgwD/jYcA/5CCAP+PgQD/jYIA/4p9AP+KgAD/iXwA/46CAP+MgAD/jIQA/4t+AP+MewD/jnwA/41+AP+NgQD/jYcA/4yAAP+MfQD/i30A/4uDAP+JfwD/jYUA/4p/AP+LggD/ioYA/4mDAP+LfQD/iYEA/4eAAP+IhAD/hHwA/4aCAP+HgAD/h4IA/4iAAP+HgQD/hn4A/4iAAP+IfgD/iYAA/4Z+AP+GhAD/hoAA/4R8AP+FhAD/hIIA/4GCAP+DhAD/gnsA/4SAAP+FgAD/g4AA/4OBAP+CggD/fn8A/39/AP9+hAD/fIAA/3uCAP96fwD/fXwA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4B/AP98ewD/eX8A/3uDAP98gAD/foMA/39/AP9/gAD/g4EA/4OAAP+DgwD/hYAA/4R+AP+AfQD/gn8A/4SFAP+EgQD/hYEA/4V/AP+GgQD/hIIA/4aDAP+HgwD/h4EA/4V+AP+FggD/iH8A/4h/AP+JggD/iH8A/4h/AP+EgAD/ioQA/4l/AP+JgwD/iX4A/4mCAP+LgwD/ioAA/4qBAP+MggD/iYEA/4d+AP+KggD/jIAA/42DAP+NfQD/j4EA/5CFAP+PgwD/jH0A/4yDAP+JfgD/i30A/4x+AP+KfwD/i4EA/458AP+MgAD/iYIA/5CDAP+LegD/jYAA/45+AP+OgQD/kH4A/5CCAP+RgQD/jn8A/5OHAP+SfwD/j4YA/4t5AP+SgAD/kYUA/5KBAP+PhgD/lH8A/5N/AP+SfwD/kXwA/5V+AP+VfgD/kXwA/5J/AP+TfwD/lH8A/4+GAP+SgQD/kYUA/5KAAP+LeQD/j4YA/5J/AP+ThwD/jn8A/5GBAP+QggD/kH4A/46BAP+OfgD/jYAA/4t6AP+QgwD/iYIA/4yAAP+OfAD/i4EA/4p/AP+MfgD/i30A/4l+AP+MgwD/jH0A/4+DAP+QhQD/j4EA/419AP+NgwD/jIAA/4qCAP+HfgD/iYEA/4yCAP+KgQD/ioAA/4uDAP+JggD/iX4A/4mDAP+JfwD/ioQA/4SAAP+IfwD/iH8A/4mCAP+IfwD/iH8A/4WCAP+FfgD/h4EA/4eDAP+GgwD/hIIA/4aBAP+FfwD/hYEA/4SBAP+EhQD/gn8A/4B9AP+EfgD/hYAA/4ODAP+DgAD/g4EA/3+AAP9/fwD/foMA/3yAAP97gwD/eX8A/3x7AP+AfwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfgD/e3sA/3h/AP96ggD/fIIA/32CAP9/ggD/gIIA/4GCAP+BgQD/hYEA/4SCAP+EggD/goEA/399AP+FggD/hX0A/4h/AP+IfQD/hX4A/4SAAP+FggD/hYMA/4N8AP+EgAD/g4MA/4V/AP+GhgD/iIYA/4iDAP+JfwD/hoAA/4WAAP+KggD/iXwA/4mHAP+KfgD/hnsA/4WEAP+JgQD/i4IA/4mCAP+JgQD/ioUA/4uEAP+JeQD/joMA/4p6AP+NgQD/jn4A/498AP+MggD/iX4A/4p/AP+NhAD/iH8A/4yDAP+OggD/kX8A/49/AP+RfgD/j4AA/5F/AP+ShgD/koAA/5GAAP+RggD/jn8A/4+AAP+OgwD/kX0A/5KAAP+SgQD/lYAA/495AP+RgwD/kHwA/5J/AP+WhQD/loIA/5J9AP+ZgQD/mYEA/5J9AP+WggD/loUA/5J/AP+QfAD/kYMA/495AP+VgAD/koEA/5KAAP+RfQD/joMA/4+AAP+OfwD/kYIA/5GAAP+SgAD/koYA/5F/AP+PgAD/kX4A/49/AP+RfwD/joIA/4yDAP+IfwD/jYQA/4p/AP+JfgD/jIIA/498AP+OfgD/jYEA/4p6AP+OgwD/iXkA/4uEAP+KhQD/iYEA/4mCAP+LggD/iYEA/4WEAP+GewD/in4A/4mHAP+JfAD/ioIA/4WAAP+GgAD/iX8A/4iDAP+IhgD/hoYA/4V/AP+DgwD/hIAA/4N8AP+FgwD/hYIA/4SAAP+FfgD/iH0A/4h/AP+FfQD/hYIA/399AP+CgQD/hIIA/4SCAP+FgQD/gYEA/4GCAP+AggD/f4IA/32CAP98ggD/eoIA/3h/AP97ewD/gH4A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/f30A/3p7AP94fwD/eIEA/32EAP98fQD/f4UA/3+BAP+BgwD/gIEA/4KCAP+CgQD/gnoA/4B/AP+BfQD/g4EA/4WCAP+GgAD/iIMA/4eAAP+FgQD/gYQA/4eDAP+DgAD/g3sA/4WBAP+EfgD/hYEA/4Z/AP+JfQD/iYEA/4d8AP+GggD/h4MA/4qDAP+JgwD/hoQA/4Z/AP+HgQD/iX8A/4mBAP+GfQD/iIUA/4V+AP+LgwD/iH8A/4t6AP+MhAD/jIQA/4p/AP+LgQD/iH0A/41/AP+MgAD/i34A/4p/AP+NfgD/jnsA/5CCAP+QgAD/kYUA/5ODAP+TgQD/kX4A/5SEAP+ShgD/koUA/5OHAP+OgwD/joQA/4+CAP+TggD/lHYA/5mEAP+SfgD/jYEA/5OIAP+VfgD/loUA/5d9AP+UgQD/m4EA/5uBAP+UgQD/l30A/5aFAP+VfgD/k4gA/42BAP+SfgD/mYQA/5R2AP+TggD/j4IA/46EAP+OgwD/k4cA/5KFAP+ShgD/lIQA/5F+AP+TgQD/k4MA/5GFAP+QgAD/kIIA/457AP+NfgD/in8A/4t+AP+MgAD/jX8A/4h9AP+LgQD/in8A/4yEAP+MhAD/i3oA/4h/AP+LgwD/hX4A/4iFAP+GfQD/iYEA/4l/AP+HgQD/hn8A/4aEAP+JgwD/ioMA/4eDAP+GggD/h3wA/4mBAP+JfQD/hn8A/4WBAP+EfgD/hYEA/4N7AP+DgAD/h4MA/4GEAP+FgQD/h4AA/4iDAP+GgAD/hYIA/4OBAP+BfQD/gH8A/4J6AP+CgQD/goIA/4CBAP+BgwD/f4EA/3+FAP98fQD/fYQA/3iBAP94fwD/ensA/399AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/358AP95ewD/d4AA/3qDAP98ggD/fIEA/31/AP+AgQD/gIEA/4GAAP+BgQD/fn8A/4F9AP+CfwD/hH8A/4SDAP+GggD/h38A/4eCAP+EgAD/g4MA/4OAAP+AgAD/hH4A/4ODAP+EewD/gn4A/4F+AP+EgQD/hoIA/4iDAP+IfwD/h4gA/4t9AP+MhgD/jIYA/4yAAP+JfQD/iogA/4l/AP+GgAD/h4EA/4uCAP+LfAD/in8A/4uFAP+MggD/ioAA/4qBAP+KgQD/h4AA/4qDAP+OfQD/i3oA/4x/AP+OgwD/kYEA/5F6AP+UgwD/kn8A/5eDAP+PewD/k3sA/5OBAP+TgAD/koUA/5J/AP+SfwD/kX0A/4+CAP+OewD/koIA/5iBAP+VggD/k4IA/5OAAP+UgQD/mH4A/5p9AP+XggD/lYMA/5aDAP+WgwD/lYMA/5eCAP+afQD/mH4A/5SBAP+TgAD/k4IA/5WCAP+YgQD/koIA/457AP+PggD/kX0A/5J/AP+SfwD/koUA/5OAAP+TgQD/k3sA/497AP+XgwD/kn8A/5SDAP+RegD/kYEA/46DAP+MfwD/i3oA/459AP+KgwD/h4AA/4qBAP+KgQD/ioAA/4yCAP+LhQD/in8A/4t8AP+LggD/h4EA/4aAAP+JfwD/iogA/4l9AP+MgAD/jIYA/4yGAP+LfQD/h4gA/4h/AP+IgwD/hoIA/4SBAP+BfgD/gn4A/4R7AP+DgwD/hH4A/4CAAP+DgAD/g4MA/4SAAP+HggD/h38A/4aCAP+EgwD/hH8A/4J/AP+BfQD/fn8A/4GBAP+BgAD/gIEA/4CBAP99fwD/fIEA/3yCAP96gwD/d4AA/3l7AP9+fAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP99ewD/eHsA/3aAAP97hgD/fH0A/3yCAP9+ggD/f4UA/4B9AP9/fgD/gIIA/4SDAP+BggD/gYMA/4KAAP+EggD/hX0A/4R6AP+GfQD/hIIA/4J9AP+FfwD/g34A/4WAAP+FfQD/hIMA/4R8AP+BgwD/gn8A/4R+AP+FfgD/iIEA/4eFAP+IfwD/ioAA/4t9AP+LiAD/in0A/4qCAP+KegD/iYYA/4uAAP+KfwD/iH4A/4uBAP+MhgD/jIIA/4t/AP+LewD/in0A/4h9AP+NgAD/i3wA/4mAAP+NggD/koUA/5R/AP+RggD/lIMA/5SAAP+ShAD/lIEA/5N/AP+PfQD/lIMA/456AP+PfQD/j4YA/5KAAP+TggD/koIA/5p0AP+YgwD/mHkA/5V9AP+WgAD/lXkA/5N+AP+chQD/l38A/5OBAP+VgQD/lYEA/5OBAP+XfwD/nIUA/5N+AP+VeQD/loAA/5V9AP+YeQD/mIMA/5p0AP+SggD/k4IA/5KAAP+PhgD/j30A/456AP+UgwD/j30A/5N/AP+UgQD/koQA/5SAAP+UgwD/kYIA/5R/AP+ShQD/jYIA/4mAAP+LfAD/jYAA/4h9AP+KfQD/i3sA/4t/AP+MggD/jIYA/4uBAP+IfgD/in8A/4uAAP+JhgD/inoA/4qCAP+KfQD/i4gA/4t9AP+KgAD/iH8A/4eFAP+IgQD/hX4A/4R+AP+CfwD/gYMA/4R8AP+EgwD/hX0A/4WAAP+DfgD/hX8A/4J9AP+EggD/hn0A/4R6AP+FfQD/hIIA/4KAAP+BgwD/gYIA/4SDAP+AggD/f34A/4B9AP9/hQD/foIA/3yCAP98fQD/e4YA/3aAAP94ewD/fXsA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfwD/fHsA/3d7AP92gwD/fIMA/3x+AP98fwD/f4EA/39/AP9/gAD/f4AA/4GFAP+BfQD/f4MA/4OBAP+DggD/gn0A/4WCAP+GgQD/hYUA/4V9AP+CegD/gYoA/4OAAP+DgwD/goYA/4SFAP+DfAD/hIIA/4OAAP+EfgD/gn0A/4mDAP+HfQD/h4AA/4aAAP+LhQD/h38A/4iCAP+JgwD/iX0A/4aBAP+HhAD/iYAA/4p9AP+JeQD/jX8A/41/AP+PggD/i4EA/4p+AP+JgAD/jn0A/5GDAP+PfwD/joUA/5SAAP+TfgD/kn0A/5J8AP+UggD/lIEA/5WAAP+UfgD/kn4A/5CBAP+OgAD/jYEA/4t5AP+SgQD/lHYA/5iBAP+YgwD/k4AA/5V/AP+YfwD/l4IA/5iCAP+ZggD/mocA/5eAAP+UfAD/knoA/5J6AP+UfAD/l4AA/5qHAP+ZggD/mIIA/5eCAP+YfwD/lX8A/5OAAP+YgwD/mIEA/5R2AP+SgQD/i3kA/42BAP+OgAD/kIEA/5J+AP+UfgD/lYAA/5SBAP+UggD/knwA/5J9AP+TfgD/lIAA/46FAP+PfwD/kYMA/459AP+JgAD/in4A/4uBAP+PggD/jX8A/41/AP+JeQD/in0A/4mAAP+HhAD/hoEA/4l9AP+JgwD/iIIA/4d/AP+LhQD/hoAA/4eAAP+HfQD/iYMA/4J9AP+EfgD/g4AA/4SCAP+DfAD/hIUA/4KGAP+DgwD/g4AA/4GKAP+CegD/hX0A/4WFAP+GgQD/hYIA/4J9AP+DggD/g4EA/3+DAP+BfQD/gYUA/3+AAP9/gAD/f38A/3+BAP98fwD/fH4A/3yDAP92gwD/d3sA/3x7AP+AfwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gH4A/3t7AP92fQD/eIIA/3uDAP98gQD/fH8A/3+DAP9/gQD/f4EA/397AP+BggD/goIA/4KDAP+CgwD/g34A/4KAAP+CfQD/g4IA/4eBAP+EfgD/hYIA/4OAAP+FfgD/gH0A/4GCAP+DhgD/gH8A/4B+AP+CfgD/hIMA/4B6AP+EgAD/h4AA/4iDAP+HgwD/h4AA/4iFAP+EgAD/g4EA/4eCAP+EfQD/iYIA/4mCAP+IgwD/iIAA/4p8AP+JfwD/jYQA/4iDAP+KfgD/jYIA/46CAP+OgQD/kIMA/5B/AP+SgQD/lIMA/5GAAP+TgAD/lYIA/5GBAP+UhAD/lIIA/5OAAP+SfgD/kHsA/49/AP+SgAD/lYAA/5mEAP+VggD/mHkA/5V/AP+WgQD/mIAA/5d/AP+ZggD/mn8A/5yDAP+bewD/lIkA/5Z/AP+WfwD/lIkA/5t7AP+cgwD/mn8A/5mCAP+XfwD/mIAA/5aBAP+VfwD/mHkA/5WCAP+ZhAD/lYAA/5KAAP+PfwD/kHsA/5J+AP+TgAD/lIIA/5SEAP+RgQD/lYIA/5OAAP+RgAD/lIMA/5KBAP+QfwD/kIMA/46BAP+OggD/jYIA/4p+AP+IgwD/jYQA/4l/AP+KfAD/iIAA/4iDAP+JggD/iYIA/4R9AP+HggD/g4EA/4SAAP+IhQD/h4AA/4eDAP+IgwD/h4AA/4SAAP+AegD/hIMA/4J+AP+AfgD/gH8A/4OGAP+BggD/gH0A/4V+AP+DgAD/hYIA/4R+AP+HgQD/g4IA/4J9AP+CgAD/g34A/4KDAP+CgwD/goIA/4GCAP9/ewD/f4EA/3+BAP9/gwD/fH8A/3yBAP97gwD/eIIA/3Z9AP97ewD/gH4A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/399AP95ewD/d4EA/3eCAP97gQD/e38A/32DAP99gQD/gIMA/3+CAP+AgwD/gX8A/4KCAP+DgAD/g4UA/4J7AP+CfQD/gYMA/4OCAP+HgAD/h4AA/4Z8AP+FggD/hH4A/4SDAP+DfQD/gn8A/4B+AP+BfgD/gX4A/4SHAP+HhAD/h4YA/4d/AP+FegD/hHwA/4R9AP+IhQD/hnwA/4WDAP+JhQD/iHoA/4x6AP+KfgD/iHwA/4mEAP+IgAD/iYMA/4mAAP+JfgD/jYYA/5F/AP+NggD/kH8A/457AP+SfwD/lYIA/5V+AP+PfAD/kYIA/5OFAP+ShwD/k4IA/5N/AP+PegD/kH4A/5KDAP+RgAD/kYUA/495AP+SfgD/k4IA/5V9AP+YfwD/mIAA/5WCAP+XggD/mX4A/5yGAP+afgD/mH4A/5eDAP+WgAD/loAA/5eDAP+YfgD/mn4A/5yGAP+ZfgD/l4IA/5WCAP+YgAD/mH8A/5V9AP+TggD/kn4A/495AP+RhQD/kYAA/5KDAP+QfgD/j3oA/5N/AP+TggD/kocA/5OFAP+RggD/j3wA/5V+AP+VggD/kn8A/457AP+QfwD/jYIA/5F/AP+NhgD/iX4A/4mAAP+JgwD/iIAA/4mEAP+IfAD/in4A/4x6AP+IegD/iYUA/4WDAP+GfAD/iIUA/4R9AP+EfAD/hXoA/4d/AP+HhgD/h4QA/4SHAP+BfgD/gX4A/4B+AP+CfwD/g30A/4SDAP+EfgD/hYIA/4Z8AP+HgAD/h4AA/4OCAP+BgwD/gn0A/4J7AP+DhQD/g4AA/4KCAP+BfwD/gIMA/3+CAP+AgwD/fYEA/32DAP97fwD/e4EA/3eCAP93gQD/eXsA/399AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9+fAD/eHwA/3d/AP93gQD/e4EA/3t/AP97fwD/foMA/4B/AP9+gAD/gIMA/4GCAP+BgQD/g4MA/4R8AP+EfwD/g4EA/4SDAP+EewD/hYAA/4WHAP+GhwD/g34A/4N+AP+FgQD/g3sA/4WDAP+EhQD/hIAA/4B/AP+FhQD/h4AA/4l/AP+FgAD/h4IA/4aBAP+HggD/h4IA/4h+AP+GfgD/hn8A/4Z9AP+LfgD/iYIA/4iCAP+LfQD/jH8A/417AP+MgQD/iXkA/4uCAP+OgQD/joIA/49+AP+SgAD/lHwA/5OBAP+UgAD/jnoA/5SDAP+PggD/lH8A/5aBAP+RfAD/kYQA/5N+AP+PfgD/kYIA/5KBAP+RgwD/jYEA/5OAAP+WgAD/l4IA/5d/AP+XggD/mX4A/5mAAP+cfwD/mYYA/5mBAP+XgQD/mYAA/5mAAP+XgQD/mYEA/5mGAP+cfwD/mYAA/5l+AP+XggD/l38A/5eCAP+WgAD/k4AA/42BAP+RgwD/koEA/5GCAP+PfgD/k34A/5GEAP+RfAD/loEA/5R/AP+PggD/lIMA/456AP+UgAD/k4EA/5R8AP+SgAD/j34A/46CAP+OgQD/i4IA/4l5AP+MgQD/jXsA/4x/AP+LfQD/iIIA/4mCAP+LfgD/hn0A/4Z/AP+GfgD/iH4A/4eCAP+HggD/hoEA/4eCAP+FgAD/iX8A/4eAAP+FhQD/gH8A/4SAAP+EhQD/hYMA/4N7AP+FgQD/g34A/4N+AP+GhwD/hYcA/4WAAP+EewD/hIMA/4OBAP+EfwD/hHwA/4ODAP+BgQD/gYIA/4CDAP9+gAD/gH8A/36DAP97fwD/e38A/3uBAP93gQD/d38A/3h8AP9+fAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/fXsA/3h7AP91gQD/eYIA/3qCAP98fgD/eoAA/36FAP99fQD/foEA/36BAP+BggD/gIAA/4N/AP+DfwD/hIAA/4OAAP+CfwD/goEA/4KGAP+CgQD/hoAA/4aBAP+CggD/g38A/4OEAP+EgwD/g34A/4J9AP+BfwD/gn8A/4iIAP+FfQD/h4QA/4V9AP+FfwD/h30A/4aAAP+LhwD/iIYA/4aAAP+GhQD/iHwA/4qFAP+KgAD/iooA/4p+AP+JewD/iX4A/4x+AP+QfgD/jYEA/41+AP+PgwD/koIA/5aDAP+WfwD/kn8A/4yAAP+QfgD/j4IA/5WGAP+QgAD/kHkA/458AP+TgQD/kX0A/5F5AP+PhgD/kHwA/5OIAP+UgQD/lXkA/5iCAP+ZggD/mX4A/5mAAP+dhQD/m30A/5h+AP+ZgQD/mYMA/5l9AP+ZfQD/mYMA/5mBAP+YfgD/m30A/52FAP+ZgAD/mX4A/5mCAP+YggD/lXkA/5SBAP+TiAD/kHwA/4+GAP+ReQD/kX0A/5OBAP+OfAD/kHkA/5CAAP+VhgD/j4IA/5B+AP+MgAD/kn8A/5Z/AP+WgwD/koIA/4+DAP+NfgD/jYEA/5B+AP+MfgD/iX4A/4l7AP+KfgD/iooA/4qAAP+KhQD/iHwA/4aFAP+GgAD/iIYA/4uHAP+GgAD/h30A/4V/AP+FfQD/h4QA/4V9AP+IiAD/gn8A/4F/AP+CfQD/g34A/4SDAP+DhAD/g38A/4KCAP+GgQD/hoAA/4KBAP+ChgD/goEA/4J/AP+DgAD/hIAA/4N/AP+DfwD/gIAA/4GCAP9+gQD/foEA/319AP9+hQD/eoAA/3x+AP96ggD/eYIA/3WBAP94ewD/fXsA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gH8A/3x7AP93ewD/doMA/3iAAP97gwD/en0A/3yCAP9+gQD/f4EA/31/AP9+gQD/f4AA/4GFAP9+gAD/hIIA/4F+AP+FggD/g4IA/4J+AP+BfwD/gn0A/4SDAP+EfQD/hYUA/4iEAP+GfgD/h3sA/4WAAP+CfAD/hYQA/4h/AP+IgQD/h4AA/4h7AP+JgQD/hoEA/4eFAP+FfQD/hoQA/4WDAP+HgAD/hoEA/4iAAP+HfQD/h4QA/4mEAP+HggD/hn8A/4mCAP+JggD/in8A/4t9AP+NgQD/jn4A/5GAAP+TggD/lX8A/5N+AP+SggD/kIIA/5ODAP+ViQD/k4YA/5N+AP+SfQD/k4EA/46CAP+VgwD/lH8A/5J/AP+VfgD/mH4A/5N+AP+ZggD/mn8A/5yGAP+cfwD/m30A/5p+AP+XhAD/mIUA/5uBAP+efwD/nn8A/5uBAP+YhQD/l4QA/5p+AP+bfQD/nH8A/5yGAP+afwD/mYIA/5N+AP+YfgD/lX4A/5J/AP+UfwD/lYMA/46CAP+TgQD/kn0A/5N+AP+ThgD/lYkA/5ODAP+QggD/koIA/5N+AP+VfwD/k4IA/5GAAP+OfgD/jYEA/4t9AP+KfwD/iYIA/4mCAP+GfwD/h4IA/4mEAP+HhAD/h30A/4iAAP+GgQD/h4AA/4WDAP+GhAD/hX0A/4eFAP+GgQD/iYEA/4h7AP+HgAD/iIEA/4h/AP+FhAD/gnwA/4WAAP+HewD/hn4A/4iEAP+FhQD/hH0A/4SDAP+CfQD/gX8A/4J+AP+DggD/hYIA/4F+AP+EggD/foAA/4GFAP9/gAD/foEA/31/AP9/gQD/foEA/3yCAP96fQD/e4MA/3iAAP92gwD/d3sA/3x7AP+AfwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4B+AP97ewD/d34A/3V9AP94hQD/en8A/3qDAP99gQD/gIUA/399AP9+gwD/f4AA/4CAAP+AgQD/gIQA/4KDAP+FgwD/hX4A/4SEAP+CfgD/goAA/4SCAP+DggD/g4EA/4WAAP+FgQD/h4EA/4R9AP+GfgD/h4QA/4V7AP+HgwD/ioAA/4mBAP+IgAD/iH8A/4Z+AP+IgQD/iIMA/4l+AP+KgAD/hoIA/4d9AP+KgAD/iIEA/4qGAP+IegD/i38A/4l9AP+JfQD/ioEA/4mIAP+LfgD/jIMA/46BAP+SgwD/jn4A/49+AP+QfgD/j38A/42BAP+MgAD/kHwA/5B6AP+VfwD/mH8A/5N8AP+ThwD/lnoA/5N/AP+WhQD/loUA/5p9AP+chQD/mocA/5yDAP+afgD/mYYA/5h+AP+XhAD/k3wA/5p+AP+ghgD/oYUA/6GFAP+ghgD/mn4A/5N8AP+XhAD/mH4A/5mGAP+afgD/nIMA/5qHAP+chQD/mn0A/5aFAP+WhQD/k38A/5Z6AP+ThwD/k3wA/5h/AP+VfwD/kHoA/5B8AP+MgAD/jYEA/49/AP+QfgD/j34A/45+AP+SgwD/joEA/4yDAP+LfgD/iYgA/4qBAP+JfQD/iX0A/4t/AP+IegD/ioYA/4iBAP+KgAD/h30A/4aCAP+KgAD/iX4A/4iDAP+IgQD/hn4A/4h/AP+IgAD/iYEA/4qAAP+HgwD/hXsA/4eEAP+GfgD/hH0A/4eBAP+FgQD/hYAA/4OBAP+DggD/hIIA/4KAAP+CfgD/hIQA/4V+AP+FgwD/goMA/4CEAP+AgQD/gIAA/3+AAP9+gwD/f30A/4CFAP99gQD/eoMA/3p/AP94hQD/dX0A/3d+AP97ewD/gH4A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9/fQD/en0A/3h8AP90gQD/eIIA/3qDAP96fQD/foYA/397AP9+ggD/fnwA/3+DAP9/ggD/f4EA/4GAAP+EgwD/hX8A/4Z+AP+EfQD/g4AA/4OCAP+FiAD/gYQA/4KAAP+FgAD/h3wA/4h9AP+KfgD/h30A/4iCAP+HfwD/hoIA/4aBAP+HggD/hoAA/4h9AP+EgAD/h4MA/4qBAP+OhgD/jX8A/4h/AP+LhAD/iH4A/4x/AP+KfQD/i4gA/4qFAP+LgQD/iIQA/4uEAP+KgAD/in8A/4uGAP+PgQD/kIAA/5B+AP+QfgD/lIIA/5B8AP+OggD/kIIA/5J+AP+RhgD/k34A/5aCAP+WhQD/k30A/5SDAP+SfwD/loIA/5d9AP+XggD/l38A/5eAAP+bewD/mH4A/5mBAP+ZgQD/mIUA/5p+AP+ehgD/o4IA/6OCAP+jggD/o4IA/56GAP+afgD/mIUA/5mBAP+ZgQD/mH4A/5t7AP+XgAD/l38A/5eCAP+XfQD/loIA/5J/AP+UgwD/k30A/5aFAP+WggD/k34A/5GGAP+SfgD/kIIA/46CAP+QfAD/lIIA/5B+AP+QfgD/kIAA/4+BAP+LhgD/in8A/4qAAP+LhAD/iIQA/4uBAP+KhQD/i4gA/4p9AP+MfwD/iH4A/4uEAP+IfwD/jX8A/46GAP+KgQD/h4MA/4SAAP+IfQD/hoAA/4eCAP+GgQD/hoIA/4d/AP+IggD/h30A/4p+AP+IfQD/h3wA/4WAAP+CgAD/gYQA/4WIAP+DggD/g4AA/4R9AP+GfgD/hX8A/4SDAP+BgAD/f4EA/3+CAP9/gwD/fnwA/36CAP9/ewD/foYA/3p9AP96gwD/eIIA/3SBAP94fAD/en0A/399AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/f30A/3p7AP92fwD/dn8A/3eCAP94fwD/eoUA/36BAP9/ggD/fnwA/32EAP+BgwD/foIA/4J/AP+AgQD/gXwA/4KCAP+IhgD/gYQA/4OCAP+DgAD/g38A/4N/AP+CggD/hIEA/4iIAP+HgAD/hIIA/4eDAP+HhgD/hn4A/4aDAP+FegD/iIUA/4Z8AP+KfwD/h4MA/4mBAP+KfQD/joEA/4x+AP+MfQD/in4A/4x9AP+MfwD/i4AA/4h7AP+HfQD/iYIA/4h/AP+LgwD/jIMA/46DAP+LgwD/jYIA/5F/AP+PfgD/kn8A/5J8AP+ShwD/koAA/5KAAP+QfgD/jn0A/5V/AP+UfAD/loIA/5Z/AP+UeQD/kXwA/5J9AP+UgQD/lYMA/5OBAP+UfAD/lIkA/5eDAP+XgQD/mYMA/5uBAP+ghgD/o4IA/6SDAP+ffwD/n38A/6SDAP+jggD/oIYA/5uBAP+ZgwD/l4EA/5eDAP+UiQD/lHwA/5OBAP+VgwD/lIEA/5J9AP+RfAD/lHkA/5Z/AP+WggD/lHwA/5V/AP+OfQD/kH4A/5KAAP+SgAD/kocA/5J8AP+SfwD/j34A/5F/AP+NggD/i4MA/46DAP+MgwD/i4MA/4h/AP+JggD/h30A/4h7AP+LgAD/jH8A/4x9AP+KfgD/jH0A/4x+AP+OgQD/in0A/4mBAP+HgwD/in8A/4Z8AP+IhQD/hXoA/4aDAP+GfgD/h4YA/4eDAP+EggD/h4AA/4iIAP+EgQD/goIA/4N/AP+DfwD/g4AA/4OCAP+BhAD/iIYA/4KCAP+BfAD/gIEA/4J/AP9+ggD/gYMA/32EAP9+fAD/f4IA/36BAP96hQD/eH8A/3eCAP92fwD/dn8A/3p7AP9/fQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/399AP96ewD/dXwA/3aEAP93fgD/d4QA/3yDAP99gwD/gH8A/3x/AP9+gwD/foAA/35+AP9/ggD/gIAA/4GCAP+AgAD/f34A/4J+AP+FhwD/hYAA/4J8AP+BfQD/gn4A/4OBAP+HgQD/h4EA/4aAAP+KgQD/gn8A/4V7AP+GgQD/hYEA/4N8AP+GhQD/hYIA/4h+AP+IfAD/ioIA/46AAP+NfQD/jYMA/4yDAP+LgwD/iIIA/4iHAP+IfQD/iYEA/4eAAP+KhAD/i3wA/4x+AP+PfgD/jIMA/4uDAP+PfgD/k3wA/5WCAP+XggD/mHsA/5F9AP+SgwD/kIUA/5N+AP+SfgD/lYIA/5aAAP+aggD/loEA/5V+AP+ZgQD/m4EA/5aDAP+VgQD/knoA/5Z/AP+WgAD/mYAA/5l9AP+efwD/oYUA/6OCAP+ffwD/nXwA/518AP+ffwD/o4IA/6GFAP+efwD/mX0A/5mAAP+WgAD/ln8A/5J6AP+VgQD/loMA/5uBAP+ZgQD/lX4A/5aBAP+aggD/loAA/5WCAP+SfgD/k34A/5CFAP+SgwD/kX0A/5h7AP+XggD/lYIA/5N8AP+PfgD/i4MA/4yDAP+PfgD/jH4A/4t8AP+KhAD/h4AA/4mBAP+IfQD/iIcA/4iCAP+LgwD/jIMA/42DAP+NfQD/joAA/4qCAP+IfAD/iH4A/4WCAP+GhQD/g3wA/4WBAP+GgQD/hXsA/4J/AP+KgQD/hoAA/4eBAP+HgQD/g4EA/4J+AP+BfQD/gnwA/4WAAP+FhwD/gn4A/39+AP+AgAD/gYIA/4CAAP9/ggD/fn4A/36AAP9+gwD/fH8A/4B/AP99gwD/fIMA/3eEAP93fgD/doQA/3V8AP96ewD/f30A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9/fQD/ensA/3V8AP92hAD/d34A/3eEAP98gwD/fYMA/4B/AP98fwD/foMA/36AAP9+fgD/f4IA/4CAAP+BggD/gIAA/39+AP+CfgD/hYcA/4WAAP+CfAD/gX0A/4J+AP+DgQD/h4EA/4eBAP+GgAD/ioEA/4J/AP+FewD/hoEA/4WBAP+DfAD/hoUA/4WCAP+IfgD/iHwA/4qCAP+OgAD/jX0A/42DAP+MgwD/i4MA/4iCAP+IhwD/iH0A/4mBAP+HgAD/ioQA/4t8AP+MfgD/j34A/4yDAP+LgwD/j34A/5N8AP+VggD/l4IA/5h7AP+RfQD/koMA/5CFAP+TfgD/kn4A/5WCAP+WgAD/moIA/5aBAP+VfgD/mYEA/5uBAP+WgwD/lYEA/5J6AP+WfwD/loAA/5mAAP+ZfQD/nn8A/6GFAP+jggD/n38A/518AP+dfAD/n38A/6OCAP+hhQD/nn8A/5l9AP+ZgAD/loAA/5Z/AP+SegD/lYEA/5aDAP+bgQD/mYEA/5V+AP+WgQD/moIA/5aAAP+VggD/kn4A/5N+AP+QhQD/koMA/5F9AP+YewD/l4IA/5WCAP+TfAD/j34A/4uDAP+MgwD/j34A/4x+AP+LfAD/ioQA/4eAAP+JgQD/iH0A/4iHAP+IggD/i4MA/4yDAP+NgwD/jX0A/46AAP+KggD/iHwA/4h+AP+FggD/hoUA/4N8AP+FgQD/hoEA/4V7AP+CfwD/ioEA/4aAAP+HgQD/h4EA/4OBAP+CfgD/gX0A/4J8AP+FgAD/hYcA/4J+AP9/fgD/gIAA/4GCAP+AgAD/f4IA/35+AP9+gAD/foMA/3x/AP+AfwD/fYMA/3yDAP93hAD/d34A/3aEAP91fAD/ensA/399AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/f30A/3p7AP92fwD/dn8A/3eCAP94fwD/eoUA/36BAP9/ggD/fnwA/32EAP+BgwD/foIA/4J/AP+AgQD/gXwA/4KCAP+IhgD/gYQA/4OCAP+DgAD/g38A/4N/AP+CggD/hIEA/4iIAP+HgAD/hIIA/4eDAP+HhgD/hn4A/4aDAP+FegD/iIUA/4Z8AP+KfwD/h4MA/4mBAP+KfQD/joEA/4x+AP+MfQD/in4A/4x9AP+MfwD/i4AA/4h7AP+HfQD/iYIA/4h/AP+LgwD/jIMA/46DAP+LgwD/jYIA/5F/AP+PfgD/kn8A/5J8AP+ShwD/koAA/5KAAP+QfgD/jn0A/5V/AP+UfAD/loIA/5Z/AP+UeQD/kXwA/5J9AP+UgQD/lYMA/5OBAP+UfAD/lIkA/5eDAP+XgQD/mYMA/5uBAP+ghgD/o4IA/6SDAP+ffwD/n38A/6SDAP+jggD/oIYA/5uBAP+ZgwD/l4EA/5eDAP+UiQD/lHwA/5OBAP+VgwD/lIEA/5J9AP+RfAD/lHkA/5Z/AP+WggD/lHwA/5V/AP+OfQD/kH4A/5KAAP+SgAD/kocA/5J8AP+SfwD/j34A/5F/AP+NggD/i4MA/46DAP+MgwD/i4MA/4h/AP+JggD/h30A/4h7AP+LgAD/jH8A/4x9AP+KfgD/jH0A/4x+AP+OgQD/in0A/4mBAP+HgwD/in8A/4Z8AP+IhQD/hXoA/4aDAP+GfgD/h4YA/4eDAP+EggD/h4AA/4iIAP+EgQD/goIA/4N/AP+DfwD/g4AA/4OCAP+BhAD/iIYA/4KCAP+BfAD/gIEA/4J/AP9+ggD/gYMA/32EAP9+fAD/f4IA/36BAP96hQD/eH8A/3eCAP92fwD/dn8A/3p7AP9/fQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/399AP96fQD/eHwA/3SBAP94ggD/eoMA/3p9AP9+hgD/f3sA/36CAP9+fAD/f4MA/3+CAP9/gQD/gYAA/4SDAP+FfwD/hn4A/4R9AP+DgAD/g4IA/4WIAP+BhAD/goAA/4WAAP+HfAD/iH0A/4p+AP+HfQD/iIIA/4d/AP+GggD/hoEA/4eCAP+GgAD/iH0A/4SAAP+HgwD/ioEA/46GAP+NfwD/iH8A/4uEAP+IfgD/jH8A/4p9AP+LiAD/ioUA/4uBAP+IhAD/i4QA/4qAAP+KfwD/i4YA/4+BAP+QgAD/kH4A/5B+AP+UggD/kHwA/46CAP+QggD/kn4A/5GGAP+TfgD/loIA/5aFAP+TfQD/lIMA/5J/AP+WggD/l30A/5eCAP+XfwD/l4AA/5t7AP+YfgD/mYEA/5mBAP+YhQD/mn4A/56GAP+jggD/o4IA/6OCAP+jggD/noYA/5p+AP+YhQD/mYEA/5mBAP+YfgD/m3sA/5eAAP+XfwD/l4IA/5d9AP+WggD/kn8A/5SDAP+TfQD/loUA/5aCAP+TfgD/kYYA/5J+AP+QggD/joIA/5B8AP+UggD/kH4A/5B+AP+QgAD/j4EA/4uGAP+KfwD/ioAA/4uEAP+IhAD/i4EA/4qFAP+LiAD/in0A/4x/AP+IfgD/i4QA/4h/AP+NfwD/joYA/4qBAP+HgwD/hIAA/4h9AP+GgAD/h4IA/4aBAP+GggD/h38A/4iCAP+HfQD/in4A/4h9AP+HfAD/hYAA/4KAAP+BhAD/hYgA/4OCAP+DgAD/hH0A/4Z+AP+FfwD/hIMA/4GAAP9/gQD/f4IA/3+DAP9+fAD/foIA/397AP9+hgD/en0A/3qDAP94ggD/dIEA/3h8AP96fQD/f30A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfgD/e3sA/3d+AP91fQD/eIUA/3p/AP96gwD/fYEA/4CFAP9/fQD/foMA/3+AAP+AgAD/gIEA/4CEAP+CgwD/hYMA/4V+AP+EhAD/gn4A/4KAAP+EggD/g4IA/4OBAP+FgAD/hYEA/4eBAP+EfQD/hn4A/4eEAP+FewD/h4MA/4qAAP+JgQD/iIAA/4h/AP+GfgD/iIEA/4iDAP+JfgD/ioAA/4aCAP+HfQD/ioAA/4iBAP+KhgD/iHoA/4t/AP+JfQD/iX0A/4qBAP+JiAD/i34A/4yDAP+OgQD/koMA/45+AP+PfgD/kH4A/49/AP+NgQD/jIAA/5B8AP+QegD/lX8A/5h/AP+TfAD/k4cA/5Z6AP+TfwD/loUA/5aFAP+afQD/nIUA/5qHAP+cgwD/mn4A/5mGAP+YfgD/l4QA/5N8AP+afgD/oIYA/6GFAP+hhQD/oIYA/5p+AP+TfAD/l4QA/5h+AP+ZhgD/mn4A/5yDAP+ahwD/nIUA/5p9AP+WhQD/loUA/5N/AP+WegD/k4cA/5N8AP+YfwD/lX8A/5B6AP+QfAD/jIAA/42BAP+PfwD/kH4A/49+AP+OfgD/koMA/46BAP+MgwD/i34A/4mIAP+KgQD/iX0A/4l9AP+LfwD/iHoA/4qGAP+IgQD/ioAA/4d9AP+GggD/ioAA/4l+AP+IgwD/iIEA/4Z+AP+IfwD/iIAA/4mBAP+KgAD/h4MA/4V7AP+HhAD/hn4A/4R9AP+HgQD/hYEA/4WAAP+DgQD/g4IA/4SCAP+CgAD/gn4A/4SEAP+FfgD/hYMA/4KDAP+AhAD/gIEA/4CAAP9/gAD/foMA/399AP+AhQD/fYEA/3qDAP96fwD/eIUA/3V9AP93fgD/e3sA/4B+AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gH8A/3x7AP93ewD/doMA/3iAAP97gwD/en0A/3yCAP9+gQD/f4EA/31/AP9+gQD/f4AA/4GFAP9+gAD/hIIA/4F+AP+FggD/g4IA/4J+AP+BfwD/gn0A/4SDAP+EfQD/hYUA/4iEAP+GfgD/h3sA/4WAAP+CfAD/hYQA/4h/AP+IgQD/h4AA/4h7AP+JgQD/hoEA/4eFAP+FfQD/hoQA/4WDAP+HgAD/hoEA/4iAAP+HfQD/h4QA/4mEAP+HggD/hn8A/4mCAP+JggD/in8A/4t9AP+NgQD/jn4A/5GAAP+TggD/lX8A/5N+AP+SggD/kIIA/5ODAP+ViQD/k4YA/5N+AP+SfQD/k4EA/46CAP+VgwD/lH8A/5J/AP+VfgD/mH4A/5N+AP+ZggD/mn8A/5yGAP+cfwD/m30A/5p+AP+XhAD/mIUA/5uBAP+efwD/nn8A/5uBAP+YhQD/l4QA/5p+AP+bfQD/nH8A/5yGAP+afwD/mYIA/5N+AP+YfgD/lX4A/5J/AP+UfwD/lYMA/46CAP+TgQD/kn0A/5N+AP+ThgD/lYkA/5ODAP+QggD/koIA/5N+AP+VfwD/k4IA/5GAAP+OfgD/jYEA/4t9AP+KfwD/iYIA/4mCAP+GfwD/h4IA/4mEAP+HhAD/h30A/4iAAP+GgQD/h4AA/4WDAP+GhAD/hX0A/4eFAP+GgQD/iYEA/4h7AP+HgAD/iIEA/4h/AP+FhAD/gnwA/4WAAP+HewD/hn4A/4iEAP+FhQD/hH0A/4SDAP+CfQD/gX8A/4J+AP+DggD/hYIA/4F+AP+EggD/foAA/4GFAP9/gAD/foEA/31/AP9/gQD/foEA/3yCAP96fQD/e4MA/3iAAP92gwD/d3sA/3x7AP+AfwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP99ewD/eHsA/3WBAP95ggD/eoIA/3x+AP96gAD/foUA/319AP9+gQD/foEA/4GCAP+AgAD/g38A/4N/AP+EgAD/g4AA/4J/AP+CgQD/goYA/4KBAP+GgAD/hoEA/4KCAP+DfwD/g4QA/4SDAP+DfgD/gn0A/4F/AP+CfwD/iIgA/4V9AP+HhAD/hX0A/4V/AP+HfQD/hoAA/4uHAP+IhgD/hoAA/4aFAP+IfAD/ioUA/4qAAP+KigD/in4A/4l7AP+JfgD/jH4A/5B+AP+NgQD/jX4A/4+DAP+SggD/loMA/5Z/AP+SfwD/jIAA/5B+AP+PggD/lYYA/5CAAP+QeQD/jnwA/5OBAP+RfQD/kXkA/4+GAP+QfAD/k4gA/5SBAP+VeQD/mIIA/5mCAP+ZfgD/mYAA/52FAP+bfQD/mH4A/5mBAP+ZgwD/mX0A/5l9AP+ZgwD/mYEA/5h+AP+bfQD/nYUA/5mAAP+ZfgD/mYIA/5iCAP+VeQD/lIEA/5OIAP+QfAD/j4YA/5F5AP+RfQD/k4EA/458AP+QeQD/kIAA/5WGAP+PggD/kH4A/4yAAP+SfwD/ln8A/5aDAP+SggD/j4MA/41+AP+NgQD/kH4A/4x+AP+JfgD/iXsA/4p+AP+KigD/ioAA/4qFAP+IfAD/hoUA/4aAAP+IhgD/i4cA/4aAAP+HfQD/hX8A/4V9AP+HhAD/hX0A/4iIAP+CfwD/gX8A/4J9AP+DfgD/hIMA/4OEAP+DfwD/goIA/4aBAP+GgAD/goEA/4KGAP+CgQD/gn8A/4OAAP+EgAD/g38A/4N/AP+AgAD/gYIA/36BAP9+gQD/fX0A/36FAP96gAD/fH4A/3qCAP95ggD/dYEA/3h7AP99ewD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/fnwA/3h8AP93fwD/d4EA/3uBAP97fwD/e38A/36DAP+AfwD/foAA/4CDAP+BggD/gYEA/4ODAP+EfAD/hH8A/4OBAP+EgwD/hHsA/4WAAP+FhwD/hocA/4N+AP+DfgD/hYEA/4N7AP+FgwD/hIUA/4SAAP+AfwD/hYUA/4eAAP+JfwD/hYAA/4eCAP+GgQD/h4IA/4eCAP+IfgD/hn4A/4Z/AP+GfQD/i34A/4mCAP+IggD/i30A/4x/AP+NewD/jIEA/4l5AP+LggD/joEA/46CAP+PfgD/koAA/5R8AP+TgQD/lIAA/456AP+UgwD/j4IA/5R/AP+WgQD/kXwA/5GEAP+TfgD/j34A/5GCAP+SgQD/kYMA/42BAP+TgAD/loAA/5eCAP+XfwD/l4IA/5l+AP+ZgAD/nH8A/5mGAP+ZgQD/l4EA/5mAAP+ZgAD/l4EA/5mBAP+ZhgD/nH8A/5mAAP+ZfgD/l4IA/5d/AP+XggD/loAA/5OAAP+NgQD/kYMA/5KBAP+RggD/j34A/5N+AP+RhAD/kXwA/5aBAP+UfwD/j4IA/5SDAP+OegD/lIAA/5OBAP+UfAD/koAA/49+AP+OggD/joEA/4uCAP+JeQD/jIEA/417AP+MfwD/i30A/4iCAP+JggD/i34A/4Z9AP+GfwD/hn4A/4h+AP+HggD/h4IA/4aBAP+HggD/hYAA/4l/AP+HgAD/hYUA/4B/AP+EgAD/hIUA/4WDAP+DewD/hYEA/4N+AP+DfgD/hocA/4WHAP+FgAD/hHsA/4SDAP+DgQD/hH8A/4R8AP+DgwD/gYEA/4GCAP+AgwD/foAA/4B/AP9+gwD/e38A/3t/AP97gQD/d4EA/3d/AP94fAD/fnwA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/399AP95ewD/d4EA/3eCAP97gQD/e38A/32DAP99gQD/gIMA/3+CAP+AgwD/gX8A/4KCAP+DgAD/g4UA/4J7AP+CfQD/gYMA/4OCAP+HgAD/h4AA/4Z8AP+FggD/hH4A/4SDAP+DfQD/gn8A/4B+AP+BfgD/gX4A/4SHAP+HhAD/h4YA/4d/AP+FegD/hHwA/4R9AP+IhQD/hnwA/4WDAP+JhQD/iHoA/4x6AP+KfgD/iHwA/4mEAP+IgAD/iYMA/4mAAP+JfgD/jYYA/5F/AP+NggD/kH8A/457AP+SfwD/lYIA/5V+AP+PfAD/kYIA/5OFAP+ShwD/k4IA/5N/AP+PegD/kH4A/5KDAP+RgAD/kYUA/495AP+SfgD/k4IA/5V9AP+YfwD/mIAA/5WCAP+XggD/mX4A/5yGAP+afgD/mH4A/5eDAP+WgAD/loAA/5eDAP+YfgD/mn4A/5yGAP+ZfgD/l4IA/5WCAP+YgAD/mH8A/5V9AP+TggD/kn4A/495AP+RhQD/kYAA/5KDAP+QfgD/j3oA/5N/AP+TggD/kocA/5OFAP+RggD/j3wA/5V+AP+VggD/kn8A/457AP+QfwD/jYIA/5F/AP+NhgD/iX4A/4mAAP+JgwD/iIAA/4mEAP+IfAD/in4A/4x6AP+IegD/iYUA/4WDAP+GfAD/iIUA/4R9AP+EfAD/hXoA/4d/AP+HhgD/h4QA/4SHAP+BfgD/gX4A/4B+AP+CfwD/g30A/4SDAP+EfgD/hYIA/4Z8AP+HgAD/h4AA/4OCAP+BgwD/gn0A/4J7AP+DhQD/g4AA/4KCAP+BfwD/gIMA/3+CAP+AgwD/fYEA/32DAP97fwD/e4EA/3eCAP93gQD/eXsA/399AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfgD/e3sA/3Z9AP94ggD/e4MA/3yBAP98fwD/f4MA/3+BAP9/gQD/f3sA/4GCAP+CggD/goMA/4KDAP+DfgD/goAA/4J9AP+DggD/h4EA/4R+AP+FggD/g4AA/4V+AP+AfQD/gYIA/4OGAP+AfwD/gH4A/4J+AP+EgwD/gHoA/4SAAP+HgAD/iIMA/4eDAP+HgAD/iIUA/4SAAP+DgQD/h4IA/4R9AP+JggD/iYIA/4iDAP+IgAD/inwA/4l/AP+NhAD/iIMA/4p+AP+NggD/joIA/46BAP+QgwD/kH8A/5KBAP+UgwD/kYAA/5OAAP+VggD/kYEA/5SEAP+UggD/k4AA/5J+AP+QewD/j38A/5KAAP+VgAD/mYQA/5WCAP+YeQD/lX8A/5aBAP+YgAD/l38A/5mCAP+afwD/nIMA/5t7AP+UiQD/ln8A/5Z/AP+UiQD/m3sA/5yDAP+afwD/mYIA/5d/AP+YgAD/loEA/5V/AP+YeQD/lYIA/5mEAP+VgAD/koAA/49/AP+QewD/kn4A/5OAAP+UggD/lIQA/5GBAP+VggD/k4AA/5GAAP+UgwD/koEA/5B/AP+QgwD/joEA/46CAP+NggD/in4A/4iDAP+NhAD/iX8A/4p8AP+IgAD/iIMA/4mCAP+JggD/hH0A/4eCAP+DgQD/hIAA/4iFAP+HgAD/h4MA/4iDAP+HgAD/hIAA/4B6AP+EgwD/gn4A/4B+AP+AfwD/g4YA/4GCAP+AfQD/hX4A/4OAAP+FggD/hH4A/4eBAP+DggD/gn0A/4KAAP+DfgD/goMA/4KDAP+CggD/gYIA/397AP9/gQD/f4EA/3+DAP98fwD/fIEA/3uDAP94ggD/dn0A/3t7AP+AfgD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gH8A/3x7AP93ewD/doMA/3yDAP98fgD/fH8A/3+BAP9/fwD/f4AA/3+AAP+BhQD/gX0A/3+DAP+DgQD/g4IA/4J9AP+FggD/hoEA/4WFAP+FfQD/gnoA/4GKAP+DgAD/g4MA/4KGAP+EhQD/g3wA/4SCAP+DgAD/hH4A/4J9AP+JgwD/h30A/4eAAP+GgAD/i4UA/4d/AP+IggD/iYMA/4l9AP+GgQD/h4QA/4mAAP+KfQD/iXkA/41/AP+NfwD/j4IA/4uBAP+KfgD/iYAA/459AP+RgwD/j38A/46FAP+UgAD/k34A/5J9AP+SfAD/lIIA/5SBAP+VgAD/lH4A/5J+AP+QgQD/joAA/42BAP+LeQD/koEA/5R2AP+YgQD/mIMA/5OAAP+VfwD/mH8A/5eCAP+YggD/mYIA/5qHAP+XgAD/lHwA/5J6AP+SegD/lHwA/5eAAP+ahwD/mYIA/5iCAP+XggD/mH8A/5V/AP+TgAD/mIMA/5iBAP+UdgD/koEA/4t5AP+NgQD/joAA/5CBAP+SfgD/lH4A/5WAAP+UgQD/lIIA/5J8AP+SfQD/k34A/5SAAP+OhQD/j38A/5GDAP+OfQD/iYAA/4p+AP+LgQD/j4IA/41/AP+NfwD/iXkA/4p9AP+JgAD/h4QA/4aBAP+JfQD/iYMA/4iCAP+HfwD/i4UA/4aAAP+HgAD/h30A/4mDAP+CfQD/hH4A/4OAAP+EggD/g3wA/4SFAP+ChgD/g4MA/4OAAP+BigD/gnoA/4V9AP+FhQD/hoEA/4WCAP+CfQD/g4IA/4OBAP9/gwD/gX0A/4GFAP9/gAD/f4AA/39/AP9/gQD/fH8A/3x+AP98gwD/doMA/3d7AP98ewD/gH8A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP99ewD/eHsA/3aAAP97hgD/fH0A/3yCAP9+ggD/f4UA/4B9AP9/fgD/gIIA/4SDAP+BggD/gYMA/4KAAP+EggD/hX0A/4R6AP+GfQD/hIIA/4J9AP+FfwD/g34A/4WAAP+FfQD/hIMA/4R8AP+BgwD/gn8A/4R+AP+FfgD/iIEA/4eFAP+IfwD/ioAA/4t9AP+LiAD/in0A/4qCAP+KegD/iYYA/4uAAP+KfwD/iH4A/4uBAP+MhgD/jIIA/4t/AP+LewD/in0A/4h9AP+NgAD/i3wA/4mAAP+NggD/koUA/5R/AP+RggD/lIMA/5SAAP+ShAD/lIEA/5N/AP+PfQD/lIMA/456AP+PfQD/j4YA/5KAAP+TggD/koIA/5p0AP+YgwD/mHkA/5V9AP+WgAD/lXkA/5N+AP+chQD/l38A/5OBAP+VgQD/lYEA/5OBAP+XfwD/nIUA/5N+AP+VeQD/loAA/5V9AP+YeQD/mIMA/5p0AP+SggD/k4IA/5KAAP+PhgD/j30A/456AP+UgwD/j30A/5N/AP+UgQD/koQA/5SAAP+UgwD/kYIA/5R/AP+ShQD/jYIA/4mAAP+LfAD/jYAA/4h9AP+KfQD/i3sA/4t/AP+MggD/jIYA/4uBAP+IfgD/in8A/4uAAP+JhgD/inoA/4qCAP+KfQD/i4gA/4t9AP+KgAD/iH8A/4eFAP+IgQD/hX4A/4R+AP+CfwD/gYMA/4R8AP+EgwD/hX0A/4WAAP+DfgD/hX8A/4J9AP+EggD/hn0A/4R6AP+FfQD/hIIA/4KAAP+BgwD/gYIA/4SDAP+AggD/f34A/4B9AP9/hQD/foIA/3yCAP98fQD/e4YA/3aAAP94ewD/fXsA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/fnwA/3l7AP93gAD/eoMA/3yCAP98gQD/fX8A/4CBAP+AgQD/gYAA/4GBAP9+fwD/gX0A/4J/AP+EfwD/hIMA/4aCAP+HfwD/h4IA/4SAAP+DgwD/g4AA/4CAAP+EfgD/g4MA/4R7AP+CfgD/gX4A/4SBAP+GggD/iIMA/4h/AP+HiAD/i30A/4yGAP+MhgD/jIAA/4l9AP+KiAD/iX8A/4aAAP+HgQD/i4IA/4t8AP+KfwD/i4UA/4yCAP+KgAD/ioEA/4qBAP+HgAD/ioMA/459AP+LegD/jH8A/46DAP+RgQD/kXoA/5SDAP+SfwD/l4MA/497AP+TewD/k4EA/5OAAP+ShQD/kn8A/5J/AP+RfQD/j4IA/457AP+SggD/mIEA/5WCAP+TggD/k4AA/5SBAP+YfgD/mn0A/5eCAP+VgwD/loMA/5aDAP+VgwD/l4IA/5p9AP+YfgD/lIEA/5OAAP+TggD/lYIA/5iBAP+SggD/jnsA/4+CAP+RfQD/kn8A/5J/AP+ShQD/k4AA/5OBAP+TewD/j3sA/5eDAP+SfwD/lIMA/5F6AP+RgQD/joMA/4x/AP+LegD/jn0A/4qDAP+HgAD/ioEA/4qBAP+KgAD/jIIA/4uFAP+KfwD/i3wA/4uCAP+HgQD/hoAA/4l/AP+KiAD/iX0A/4yAAP+MhgD/jIYA/4t9AP+HiAD/iH8A/4iDAP+GggD/hIEA/4F+AP+CfgD/hHsA/4ODAP+EfgD/gIAA/4OAAP+DgwD/hIAA/4eCAP+HfwD/hoIA/4SDAP+EfwD/gn8A/4F9AP9+fwD/gYEA/4GAAP+AgQD/gIEA/31/AP98gQD/fIIA/3qDAP93gAD/eXsA/358AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/399AP96ewD/eH8A/3iBAP99hAD/fH0A/3+FAP9/gQD/gYMA/4CBAP+CggD/goEA/4J6AP+AfwD/gX0A/4OBAP+FggD/hoAA/4iDAP+HgAD/hYEA/4GEAP+HgwD/g4AA/4N7AP+FgQD/hH4A/4WBAP+GfwD/iX0A/4mBAP+HfAD/hoIA/4eDAP+KgwD/iYMA/4aEAP+GfwD/h4EA/4l/AP+JgQD/hn0A/4iFAP+FfgD/i4MA/4h/AP+LegD/jIQA/4yEAP+KfwD/i4EA/4h9AP+NfwD/jIAA/4t+AP+KfwD/jX4A/457AP+QggD/kIAA/5GFAP+TgwD/k4EA/5F+AP+UhAD/koYA/5KFAP+ThwD/joMA/46EAP+PggD/k4IA/5R2AP+ZhAD/kn4A/42BAP+TiAD/lX4A/5aFAP+XfQD/lIEA/5uBAP+bgQD/lIEA/5d9AP+WhQD/lX4A/5OIAP+NgQD/kn4A/5mEAP+UdgD/k4IA/4+CAP+OhAD/joMA/5OHAP+ShQD/koYA/5SEAP+RfgD/k4EA/5ODAP+RhQD/kIAA/5CCAP+OewD/jX4A/4p/AP+LfgD/jIAA/41/AP+IfQD/i4EA/4p/AP+MhAD/jIQA/4t6AP+IfwD/i4MA/4V+AP+IhQD/hn0A/4mBAP+JfwD/h4EA/4Z/AP+GhAD/iYMA/4qDAP+HgwD/hoIA/4d8AP+JgQD/iX0A/4Z/AP+FgQD/hH4A/4WBAP+DewD/g4AA/4eDAP+BhAD/hYEA/4eAAP+IgwD/hoAA/4WCAP+DgQD/gX0A/4B/AP+CegD/goEA/4KCAP+AgQD/gYMA/3+BAP9/hQD/fH0A/32EAP94gQD/eH8A/3p7AP9/fQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfgD/e3sA/3h/AP96ggD/fIIA/32CAP9/ggD/gIIA/4GCAP+BgQD/hYEA/4SCAP+EggD/goEA/399AP+FggD/hX0A/4h/AP+IfQD/hX4A/4SAAP+FggD/hYMA/4N8AP+EgAD/g4MA/4V/AP+GhgD/iIYA/4iDAP+JfwD/hoAA/4WAAP+KggD/iXwA/4mHAP+KfgD/hnsA/4WEAP+JgQD/i4IA/4mCAP+JgQD/ioUA/4uEAP+JeQD/joMA/4p6AP+NgQD/jn4A/498AP+MggD/iX4A/4p/AP+NhAD/iH8A/4yDAP+OggD/kX8A/49/AP+RfgD/j4AA/5F/AP+ShgD/koAA/5GAAP+RggD/jn8A/4+AAP+OgwD/kX0A/5KAAP+SgQD/lYAA/495AP+RgwD/kHwA/5J/AP+WhQD/loIA/5J9AP+ZgQD/mYEA/5J9AP+WggD/loUA/5J/AP+QfAD/kYMA/495AP+VgAD/koEA/5KAAP+RfQD/joMA/4+AAP+OfwD/kYIA/5GAAP+SgAD/koYA/5F/AP+PgAD/kX4A/49/AP+RfwD/joIA/4yDAP+IfwD/jYQA/4p/AP+JfgD/jIIA/498AP+OfgD/jYEA/4p6AP+OgwD/iXkA/4uEAP+KhQD/iYEA/4mCAP+LggD/iYEA/4WEAP+GewD/in4A/4mHAP+JfAD/ioIA/4WAAP+GgAD/iX8A/4iDAP+IhgD/hoYA/4V/AP+DgwD/hIAA/4N8AP+FgwD/hYIA/4SAAP+FfgD/iH0A/4h/AP+FfQD/hYIA/399AP+CgQD/hIIA/4SCAP+FgQD/gYEA/4GCAP+AggD/f4IA/32CAP98ggD/eoIA/3h/AP97ewD/gH4A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gH8A/3x7AP95fwD/e4MA/3yAAP9+gwD/f38A/3+AAP+DgQD/g4AA/4ODAP+FgAD/hH4A/4B9AP+CfwD/hIUA/4SBAP+FgQD/hX8A/4aBAP+EggD/hoMA/4eDAP+HgQD/hX4A/4WCAP+IfwD/iH8A/4mCAP+IfwD/iH8A/4SAAP+KhAD/iX8A/4mDAP+JfgD/iYIA/4uDAP+KgAD/ioEA/4yCAP+JgQD/h34A/4qCAP+MgAD/jYMA/419AP+PgQD/kIUA/4+DAP+MfQD/jIMA/4l+AP+LfQD/jH4A/4p/AP+LgQD/jnwA/4yAAP+JggD/kIMA/4t6AP+NgAD/jn4A/46BAP+QfgD/kIIA/5GBAP+OfwD/k4cA/5J/AP+PhgD/i3kA/5KAAP+RhQD/koEA/4+GAP+UfwD/k38A/5J/AP+RfAD/lX4A/5V+AP+RfAD/kn8A/5N/AP+UfwD/j4YA/5KBAP+RhQD/koAA/4t5AP+PhgD/kn8A/5OHAP+OfwD/kYEA/5CCAP+QfgD/joEA/45+AP+NgAD/i3oA/5CDAP+JggD/jIAA/458AP+LgQD/in8A/4x+AP+LfQD/iX4A/4yDAP+MfQD/j4MA/5CFAP+PgQD/jX0A/42DAP+MgAD/ioIA/4d+AP+JgQD/jIIA/4qBAP+KgAD/i4MA/4mCAP+JfgD/iYMA/4l/AP+KhAD/hIAA/4h/AP+IfwD/iYIA/4h/AP+IfwD/hYIA/4V+AP+HgQD/h4MA/4aDAP+EggD/hoEA/4V/AP+FgQD/hIEA/4SFAP+CfwD/gH0A/4R+AP+FgAD/g4MA/4OAAP+DgQD/f4AA/39/AP9+gwD/fIAA/3uDAP95fwD/fHsA/4B/AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP99fAD/en8A/3uCAP98gAD/foQA/39/AP9+fwD/goIA/4OBAP+DgAD/hYAA/4SAAP+CewD/g4QA/4GCAP+EggD/hYQA/4R8AP+GgAD/hoQA/4Z+AP+JgAD/iH4A/4iAAP+GfgD/h4EA/4iAAP+HggD/h4AA/4aCAP+EfAD/iIQA/4eAAP+JgQD/i30A/4mDAP+KhgD/i4IA/4p/AP+NhQD/iX8A/4uDAP+LfQD/jH0A/4yAAP+NhwD/jYEA/41+AP+OfAD/jHsA/4t+AP+MhAD/jIAA/46CAP+JfAD/ioAA/4p9AP+NggD/j4EA/5CCAP+NhwD/kIMA/5KAAP+UgAD/j4UA/4+BAP+QggD/kYIA/5KFAP+SfwD/j30A/42BAP+PfwD/kYAA/5GCAP+ReQD/lYMA/5Z6AP+UgwD/lHkA/5aBAP+WgQD/lHkA/5SDAP+WegD/lYMA/5F5AP+RggD/kYAA/49/AP+NgQD/j30A/5J/AP+ShQD/kYIA/5CCAP+PgQD/j4UA/5SAAP+SgAD/kIMA/42HAP+QggD/j4EA/42CAP+KfQD/ioAA/4l8AP+OggD/jIAA/4yEAP+LfgD/jHsA/458AP+NfgD/jYEA/42HAP+MgAD/jH0A/4t9AP+LgwD/iX8A/42FAP+KfwD/i4IA/4qGAP+JgwD/i30A/4mBAP+HgAD/iIQA/4R8AP+GggD/h4AA/4eCAP+IgAD/h4EA/4Z+AP+IgAD/iH4A/4mAAP+GfgD/hoQA/4aAAP+EfAD/hYQA/4SCAP+BggD/g4QA/4J7AP+EgAD/hYAA/4OAAP+DgQD/goIA/35/AP9/fwD/foQA/3yAAP97ggD/en8A/318AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/fnwA/3t/AP97fwD/fIIA/3+BAP9/ggD/f4IA/4OAAP+FggD/hIIA/4WCAP+FgwD/hIAA/4OFAP+FhAD/hn4A/4N+AP+FfwD/hX8A/4eCAP+IggD/iX0A/4iEAP+IfgD/iH8A/4Z/AP+KhAD/iH4A/4Z+AP+DewD/iYQA/4Z8AP+KhgD/jIAA/4d/AP+FgAD/iIMA/4l/AP+JhgD/i4IA/4l+AP+LfAD/i4EA/42GAP+SfgD/joUA/4p9AP+JgAD/ioAA/4p/AP+NhgD/jn8A/4+AAP+LfAD/joMA/4qAAP+LgQD/jYIA/5CAAP+JfgD/jYAA/4+EAP+PeQD/kIIA/4yKAP+PhQD/kH4A/5GAAP+ShgD/koUA/456AP+OgAD/kHsA/5KDAP+PfgD/kX0A/46CAP+ThwD/k30A/5Z/AP+aggD/moIA/5Z/AP+TfQD/k4cA/46CAP+RfQD/j34A/5KDAP+QewD/joAA/456AP+ShQD/koYA/5GAAP+QfgD/j4UA/4yKAP+QggD/j3kA/4+EAP+NgAD/iX4A/5CAAP+NggD/i4EA/4qAAP+OgwD/i3wA/4+AAP+OfwD/jYYA/4p/AP+KgAD/iYAA/4p9AP+OhQD/kn4A/42GAP+LgQD/i3wA/4l+AP+LggD/iYYA/4l/AP+IgwD/hYAA/4d/AP+MgAD/ioYA/4Z8AP+JhAD/g3sA/4Z+AP+IfgD/ioQA/4Z/AP+IfwD/iH4A/4iEAP+JfQD/iIIA/4eCAP+FfwD/hX8A/4N+AP+GfgD/hYQA/4OFAP+EgAD/hYMA/4WCAP+EggD/hYIA/4OAAP9/ggD/f4IA/3+BAP98ggD/e38A/3t/AP9+fAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/399AP97fgD/e4AA/3yDAP9/gAD/f38A/4GDAP+CgQD/g4IA/4OCAP+FgAD/g38A/4aDAP+DfQD/hIIA/4WHAP+FggD/hoAA/4aFAP+IgAD/iIIA/4eCAP+EgAD/hoMA/4d6AP+IgQD/iYIA/4h+AP+GgwD/hYAA/4iCAP+HhAD/i4QA/4d9AP+FewD/iIAA/4eGAP+IfwD/h4MA/4mDAP+LhQD/iX8A/4p9AP+OgwD/jn4A/41+AP+LgAD/h34A/4l+AP+MfwD/i34A/4qDAP+QfgD/jIUA/4t9AP+MggD/ioEA/4yGAP+OgwD/j4IA/418AP+RgwD/kn8A/5SAAP+QggD/lIAA/46BAP+SgAD/lIQA/5OAAP+UgwD/kIEA/5J+AP+QfgD/k34A/5OBAP+TgQD/k3wA/5aFAP+WggD/loAA/5aAAP+WggD/loUA/5N8AP+TgQD/k4EA/5N+AP+QfgD/kn4A/5CBAP+UgwD/k4AA/5SEAP+SgAD/joEA/5SAAP+QggD/lIAA/5J/AP+RgwD/jXwA/4+CAP+OgwD/jIYA/4qBAP+MggD/i30A/4yFAP+QfgD/ioMA/4t+AP+MfwD/iX4A/4d+AP+LgAD/jX4A/45+AP+OgwD/in0A/4l/AP+LhQD/iYMA/4eDAP+IfwD/h4YA/4iAAP+FewD/h30A/4uEAP+HhAD/iIIA/4WAAP+GgwD/iH4A/4mCAP+IgQD/h3oA/4aDAP+EgAD/h4IA/4iCAP+IgAD/hoUA/4aAAP+FggD/hYcA/4SCAP+DfQD/hoMA/4N/AP+FgAD/g4IA/4OCAP+CgQD/gYMA/39/AP9/gAD/fIMA/3uAAP97fgD/f30A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfgD/e30A/3uAAP99ggD/f4IA/4CCAP+BgQD/gIAA/4KAAP+AfQD/g38A/4WDAP+EfwD/hH4A/4V/AP+HgwD/h4MA/4V9AP+IfwD/i4QA/4eAAP+FgAD/h4IA/4d4AP+GfgD/hIAA/4Z5AP+GfwD/iIUA/4Z/AP+GfwD/iHsA/42EAP+IhQD/iIIA/4d8AP+DfAD/hIIA/4iEAP+GgwD/iHsA/4qFAP+JggD/jIEA/4t9AP+OgQD/jYAA/4p+AP+KgAD/jX4A/5GCAP+UfgD/koMA/5CBAP+NfwD/iX4A/4d+AP+LgQD/kIEA/5CAAP+RfAD/jX4A/5B9AP+SfwD/j3kA/5KAAP+OfgD/koYA/5F+AP+TgQD/j30A/5J+AP+TgAD/j3oA/5GEAP+OfAD/kn0A/5h/AP+WggD/lHwA/5WCAP+VggD/lHwA/5aCAP+YfwD/kn0A/458AP+RhAD/j3oA/5OAAP+SfgD/j30A/5OBAP+RfgD/koYA/45+AP+SgAD/j3kA/5J/AP+QfQD/jX4A/5F8AP+QgAD/kIEA/4uBAP+HfgD/iX4A/41/AP+QgQD/koMA/5R+AP+RggD/jX4A/4qAAP+KfgD/jYAA/46BAP+LfQD/jIEA/4mCAP+KhQD/iHsA/4aDAP+IhAD/hIIA/4N8AP+HfAD/iIIA/4iFAP+NhAD/iHsA/4Z/AP+GfwD/iIUA/4Z/AP+GeQD/hIAA/4Z+AP+HeAD/h4IA/4WAAP+HgAD/i4QA/4h/AP+FfQD/h4MA/4eDAP+FfwD/hH4A/4R/AP+FgwD/g38A/4B9AP+CgAD/gIAA/4GBAP+AggD/f4IA/32CAP97gAD/e30A/4B+AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gH8A/3x8AP97gQD/foEA/36AAP+BgwD/goIA/4OBAP+CgAD/goUA/4SEAP+DfgD/hH8A/4WAAP+FfwD/hX0A/4aCAP+GgAD/ioAA/4t/AP+IgwD/h4UA/4eBAP+EfAD/h4QA/4iEAP+IgAD/hX8A/4l/AP+JgQD/in8A/4aBAP+KewD/h34A/4Z+AP+BewD/gn8A/4R+AP+GggD/hn8A/4uAAP+LgQD/jIIA/42AAP+OggD/jX4A/42CAP+KggD/i34A/46GAP+QfgD/j38A/46BAP+OfwD/iYEA/4uCAP+IgQD/i4MA/4t6AP+QgQD/kX4A/418AP+NfgD/kYMA/4+EAP+QgwD/jYAA/5F/AP+TgQD/k3sA/5N/AP+UfgD/lIIA/5N/AP+RfAD/kHkA/5N+AP+VfwD/k34A/5V/AP+SfgD/kn4A/5V/AP+TfgD/lX8A/5N+AP+QeQD/kXwA/5N/AP+UggD/lH4A/5N/AP+TewD/k4EA/5F/AP+NgAD/kIMA/4+EAP+RgwD/jX4A/418AP+RfgD/kIEA/4t6AP+LgwD/iIEA/4uCAP+JgQD/jn8A/46BAP+PfwD/kH4A/46GAP+LfgD/ioIA/42CAP+NfgD/joIA/42AAP+MggD/i4EA/4uAAP+GfwD/hoIA/4R+AP+CfwD/gXsA/4Z+AP+HfgD/insA/4aBAP+KfwD/iYEA/4l/AP+FfwD/iIAA/4iEAP+HhAD/hHwA/4eBAP+HhQD/iIMA/4t/AP+KgAD/hoAA/4aCAP+FfQD/hX8A/4WAAP+EfwD/g34A/4SEAP+ChQD/goAA/4OBAP+CggD/gYMA/36AAP9+gQD/e4EA/3x8AP+AfwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP99fAD/e4AA/3+DAP9/gAD/gYMA/4N/AP+DfwD/g4EA/4KCAP+CggD/hIIA/4OBAP+EfwD/hIIA/4SAAP+GggD/hn4A/4h8AP+FfQD/iH8A/4WBAP+GgwD/hoQA/4Z6AP+FhAD/in8A/4t/AP+KggD/iYIA/4eBAP+MfAD/iIUA/4Z+AP+HgQD/hIEA/4eAAP+JfwD/iX8A/4mGAP+KhgD/jX8A/419AP+KgQD/joAA/45+AP+OgwD/jXoA/41+AP+OgAD/kH0A/49+AP+PgwD/jn0A/46KAP+NggD/i34A/4t8AP+MfwD/kIAA/5N7AP+RfgD/kXwA/418AP+NgAD/jYcA/4t6AP+PgAD/k4MA/497AP+UgQD/lYAA/5SEAP+TggD/loEA/5CAAP+ThgD/kHoA/5GGAP+OfQD/k34A/5N+AP+OfQD/kYYA/5B6AP+ThgD/kIAA/5aBAP+TggD/lIQA/5WAAP+UgQD/j3sA/5ODAP+PgAD/i3oA/42HAP+NgAD/jXwA/5F8AP+RfgD/k3sA/5CAAP+MfwD/i3wA/4t+AP+NggD/jooA/459AP+PgwD/j34A/5B9AP+OgAD/jX4A/416AP+OgwD/jn4A/46AAP+KgQD/jX0A/41/AP+KhgD/iYYA/4l/AP+JfwD/h4AA/4SBAP+HgQD/hn4A/4iFAP+MfAD/h4EA/4mCAP+KggD/i38A/4p/AP+FhAD/hnoA/4aEAP+GgwD/hYEA/4h/AP+FfQD/iHwA/4Z+AP+GggD/hIAA/4SCAP+EfwD/g4EA/4SCAP+CggD/goIA/4OBAP+DfwD/g38A/4GDAP9/gAD/f4MA/3uAAP99fAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/fnwA/3uBAP+AgwD/gIIA/4GAAP+CgAD/g4IA/4SCAP+EfQD/gn4A/4WAAP+DgAD/hYQA/4V7AP+DgQD/hoYA/4R7AP+FgAD/hYIA/4WEAP+FfQD/h4MA/4V+AP+HhAD/h4EA/4eEAP+JfgD/hnwA/4mFAP+MhQD/jIIA/4h+AP+GfAD/iYIA/4l1AP+FfwD/hoEA/4iEAP+IgAD/jX4A/458AP+NeQD/jH8A/4p+AP+MfgD/kX8A/5B8AP+TggD/kYEA/4+AAP+PfAD/kH4A/4l9AP+MgAD/joAA/45/AP+QhAD/i4QA/4t+AP+QgAD/kIEA/5CAAP+PggD/iX4A/5CCAP+QgwD/kX4A/5GFAP+XgwD/koQA/5SBAP+RgQD/kocA/5R/AP+VhgD/lYkA/5B8AP+SfgD/kH4A/5CFAP+QhQD/kH4A/5J+AP+QfAD/lYkA/5WGAP+UfwD/kocA/5GBAP+UgQD/koQA/5eDAP+RhQD/kX4A/5CDAP+QggD/iX4A/4+CAP+QgAD/kIEA/5CAAP+LfgD/i4QA/5CEAP+OfwD/joAA/4yAAP+JfQD/kH4A/498AP+PgAD/kYEA/5OCAP+QfAD/kX8A/4x+AP+KfgD/jH8A/415AP+OfAD/jX4A/4iAAP+IhAD/hoEA/4V/AP+JdQD/iYIA/4Z8AP+IfgD/jIIA/4yFAP+JhQD/hnwA/4l+AP+HhAD/h4EA/4eEAP+FfgD/h4MA/4V9AP+FhAD/hYIA/4WAAP+EewD/hoYA/4OBAP+FewD/hYQA/4OAAP+FgAD/gn4A/4R9AP+EggD/g4IA/4KAAP+BgAD/gIIA/4CDAP97gQD/fnwA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/399AP99gAD/gIIA/39/AP+BhQD/gn4A/4GCAP+EgAD/g4IA/4WEAP+EgwD/g4AA/4KBAP+BfQD/gYAA/4aEAP+IggD/h38A/4eEAP+IfAD/iYQA/4uEAP+FfgD/iH0A/4eBAP+GggD/iH8A/4J9AP+FfwD/iYEA/4t/AP+IfwD/iYEA/4eBAP+IgQD/jIEA/4mCAP+IgAD/joAA/5B/AP+OhgD/jYAA/4yCAP+PhQD/jYUA/46AAP+SfwD/knsA/5KCAP+NfQD/j4AA/5GEAP+QewD/j4AA/4+AAP+RgQD/joIA/457AP+LhAD/jH8A/4t6AP+QgQD/joMA/5CAAP+PgQD/iYIA/49/AP+QgAD/kn8A/5SAAP+UggD/lYIA/5OFAP+PggD/j4IA/5ODAP+MgAD/kIIA/5KAAP+SgwD/koMA/5KAAP+QggD/jIAA/5ODAP+PggD/j4IA/5OFAP+VggD/lIIA/5SAAP+SfwD/kIAA/49/AP+JggD/j4EA/5CAAP+OgwD/kIEA/4t6AP+MfwD/i4QA/457AP+OggD/kYEA/4+AAP+PgAD/kHsA/5GEAP+PgAD/jX0A/5KCAP+SewD/kn8A/46AAP+NhQD/j4UA/4yCAP+NgAD/joYA/5B/AP+OgAD/iIAA/4mCAP+MgQD/iIEA/4eBAP+JgQD/iH8A/4t/AP+JgQD/hX8A/4J9AP+IfwD/hoIA/4eBAP+IfQD/hX4A/4uEAP+JhAD/iHwA/4eEAP+HfwD/iIIA/4aEAP+BgAD/gX0A/4KBAP+DgAD/hIMA/4WEAP+DggD/hIAA/4GCAP+CfgD/gYUA/39/AP+AggD/fYAA/399AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/fX4A/36BAP+DgwD/gn8A/4F/AP+AgAD/gn8A/4J+AP+EgQD/hIIA/4N/AP+AfwD/foEA/4GCAP+DggD/gn0A/4eEAP+HgwD/h38A/4iDAP+JfwD/iH4A/4SCAP+DfwD/hXoA/4Z/AP+KfgD/h4EA/4d+AP+JgQD/hnwA/4uCAP+KfQD/i4AA/4qCAP+IfQD/hoAA/4yBAP+OgwD/jXoA/4mAAP+NgAD/j30A/45+AP+OgQD/kIAA/5J/AP+UgQD/k4MA/5SBAP+UggD/kX8A/496AP+RgQD/kn8A/5GGAP+OggD/kIQA/4t8AP+LgwD/i4EA/4yGAP+NggD/jYIA/4yAAP+RfwD/kIIA/5SDAP+UgwD/knwA/5OAAP+RggD/lIMA/5B+AP+QggD/jYEA/46CAP+SgAD/kX0A/5F9AP+SgAD/joIA/42BAP+QggD/kH4A/5SDAP+RggD/k4AA/5J8AP+UgwD/lIMA/5CCAP+RfwD/jIAA/42CAP+NggD/jIYA/4uBAP+LgwD/i3wA/5CEAP+OggD/kYYA/5J/AP+RgQD/j3oA/5F/AP+UggD/lIEA/5ODAP+UgQD/kn8A/5CAAP+OgQD/jn4A/499AP+NgAD/iYAA/416AP+OgwD/jIEA/4aAAP+IfQD/ioIA/4uAAP+KfQD/i4IA/4Z8AP+JgQD/h34A/4eBAP+KfgD/hn8A/4V6AP+DfwD/hIIA/4h+AP+JfwD/iIMA/4d/AP+HgwD/h4QA/4J9AP+DggD/gYIA/36BAP+AfwD/g38A/4SCAP+EgQD/gn4A/4J/AP+AgAD/gX8A/4J/AP+DgwD/foEA/31+AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4B+AP+AggD/goEA/4B/AP9/gAD/gH4A/4KDAP+CgwD/gX4A/4SBAP+EgwD/gH4A/3+BAP+DhQD/hXcA/4B7AP+CiAD/hX4A/4d/AP+HfgD/h3oA/4R9AP+FgAD/hn4A/4aAAP+FfgD/hoIA/4iDAP+JggD/iYEA/4d9AP+HhgD/ioUA/4d5AP+LgQD/jX0A/4uCAP+PhQD/jX0A/5CBAP+NfgD/jX8A/49+AP+NfQD/joIA/5CCAP+PhAD/kYIA/5J9AP+SgwD/lYUA/5KCAP+QfQD/kYEA/5F+AP+SfwD/kYEA/45/AP+LfgD/iIEA/4d+AP+KgQD/i4EA/4p9AP+OfAD/joIA/457AP+RegD/kYIA/5J9AP+RgAD/j3wA/456AP+MgAD/koIA/49/AP+QfAD/kocA/5h7AP+YewD/kocA/5B8AP+PfwD/koIA/4yAAP+OegD/j3wA/5GAAP+SfQD/kYIA/5F6AP+OewD/joIA/458AP+KfQD/i4EA/4qBAP+HfgD/iIEA/4t+AP+OfwD/kYEA/5J/AP+RfgD/kYEA/5B9AP+SggD/lYUA/5KDAP+SfQD/kYIA/4+EAP+QggD/joIA/419AP+PfgD/jX8A/41+AP+QgQD/jX0A/4+FAP+LggD/jX0A/4uBAP+HeQD/ioUA/4eGAP+HfQD/iYEA/4mCAP+IgwD/hoIA/4V+AP+GgAD/hn4A/4WAAP+EfQD/h3oA/4d+AP+HfwD/hX4A/4KIAP+AewD/hXcA/4OFAP9/gQD/gH4A/4SDAP+EgQD/gX4A/4KDAP+CgwD/gH4A/3+AAP+AfwD/goEA/4CCAP+AfgD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/foEA/4CFAP+AgQD/gH8A/4GFAP+CgQD/gX8A/4SEAP+EgQD/hX8A/4F/AP+BfgD/gH4A/4WEAP+BggD/g4AA/4SBAP+GiAD/iIEA/4Z7AP+EfQD/hX0A/4V+AP+GggD/hYAA/4eHAP+IggD/i4MA/4uCAP+KgQD/iX4A/4h+AP+HgAD/iYUA/4qCAP+JfwD/i4UA/5CGAP+PggD/joEA/4x/AP+OfgD/jX0A/4+CAP+SgAD/kIQA/4+AAP+PgQD/kH8A/4+BAP+RigD/kIAA/5SKAP+RgQD/kYEA/4+AAP+OgAD/jYIA/4uCAP+JfgD/jIIA/4qAAP+KgAD/i4EA/4yDAP+NfgD/kYEA/5R/AP+TfgD/lIMA/5V+AP+UgAD/kn8A/5N+AP+QfgD/lIIA/5J8AP+XggD/l4IA/5J8AP+UggD/kH4A/5N+AP+SfwD/lIAA/5V+AP+UgwD/k34A/5R/AP+RgQD/jX4A/4yDAP+LgQD/ioAA/4qAAP+MggD/iX4A/4uCAP+NggD/joAA/4+AAP+RgQD/kYEA/5SKAP+QgAD/kYoA/4+BAP+QfwD/j4EA/4+AAP+QhAD/koAA/4+CAP+NfQD/jn4A/4x/AP+OgQD/j4IA/5CGAP+LhQD/iX8A/4qCAP+JhQD/h4AA/4h+AP+JfgD/ioEA/4uCAP+LgwD/iIIA/4eHAP+FgAD/hoIA/4V+AP+FfQD/hH0A/4Z7AP+IgQD/hogA/4SBAP+DgAD/gYIA/4WEAP+AfgD/gX4A/4F/AP+FfwD/hIEA/4SEAP+BfwD/goEA/4GFAP+AfwD/gIEA/4CFAP9+gQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/399AP9+gQD/goIA/35/AP+AgQD/gYMA/4B/AP+ChgD/goIA/4F/AP+BfAD/gIEA/39+AP+CfwD/g4AA/4l/AP+GggD/hnsA/4WDAP+EgQD/hH4A/4N8AP+EfgD/hoEA/4aGAP+GfAD/iXoA/4mFAP+OfQD/jn4A/4h9AP+HfQD/hoMA/4eCAP+JfgD/i4IA/4mDAP+QhAD/jn4A/5B8AP+QgAD/i3wA/417AP+PgQD/kH8A/5J/AP+OgwD/jIEA/4+CAP+OfgD/j38A/5CFAP+QgAD/kH0A/496AP+PgAD/jIAA/46KAP+JgQD/jX8A/4t9AP+OgwD/iXwA/4p/AP+IfwD/in8A/46DAP+ShQD/lIAA/5KBAP+VggD/k4EA/5Z/AP+VfwD/j34A/5B+AP+SfwD/lYIA/5WCAP+SfwD/kH4A/49+AP+VfwD/ln8A/5OBAP+VggD/koEA/5SAAP+ShQD/joMA/4p/AP+IfwD/in8A/4l8AP+OgwD/i30A/41/AP+JgQD/jooA/4yAAP+PgAD/j3oA/5B9AP+QgAD/kIUA/49/AP+OfgD/j4IA/4yBAP+OgwD/kn8A/5B/AP+PgQD/jXsA/4t8AP+QgAD/kHwA/45+AP+QhAD/iYMA/4uCAP+JfgD/h4IA/4aDAP+HfQD/iH0A/45+AP+OfQD/iYUA/4l6AP+GfAD/hoYA/4aBAP+EfgD/g3wA/4R+AP+EgQD/hYMA/4Z7AP+GggD/iX8A/4OAAP+CfwD/f34A/4CBAP+BfAD/gX8A/4KCAP+ChgD/gH8A/4GDAP+AgQD/fn8A/4KCAP9+gQD/f30A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CCAP+BfAD/gYIA/4KAAP+BfwD/gX4A/4GCAP+AfQD/f4EA/3+AAP+BggD/goAA/4GAAP+EgAD/hYMA/4aFAP+DfQD/hoAA/4WAAP+EfgD/hoEA/4Z7AP+FggD/iIMA/4mCAP+LfwD/ioIA/4l/AP+HgwD/iH4A/4d+AP+KhAD/i4MA/4t/AP+LfgD/jYAA/5CCAP+SfwD/jn8A/4p9AP+LhgD/jIAA/418AP+PfwD/jX8A/41/AP+PfQD/kX8A/5J+AP+PfwD/kYoA/5KCAP+RfwD/kHsA/4l9AP+OfQD/jn8A/5CBAP+MhQD/i3wA/46CAP+MfgD/jYQA/4t+AP+MfwD/jYIA/46FAP+QfwD/kn8A/5R8AP+WgwD/k4IA/45+AP+QfgD/j34A/5N8AP+TfAD/j34A/5B+AP+OfgD/k4IA/5aDAP+UfAD/kn8A/5B/AP+OhQD/jYIA/4x/AP+LfgD/jYQA/4x+AP+OggD/i3wA/4yFAP+QgQD/jn8A/459AP+JfQD/kHsA/5F/AP+SggD/kYoA/49/AP+SfgD/kX8A/499AP+NfwD/jX8A/49/AP+NfAD/jIAA/4uGAP+KfQD/jn8A/5J/AP+QggD/jYAA/4t+AP+LfwD/i4MA/4qEAP+HfgD/iH4A/4eDAP+JfwD/ioIA/4t/AP+JggD/iIMA/4WCAP+GewD/hoEA/4R+AP+FgAD/hoAA/4N9AP+GhQD/hYMA/4SAAP+BgAD/goAA/4GCAP9/gAD/f4EA/4B9AP+BggD/gX4A/4F/AP+CgAD/gYIA/4F8AP+AggD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/g4IA/4F9AP+BgQD/f3wA/3+AAP99fwD/f34A/4GAAP+CfwD/gX4A/4F/AP+BfQD/g4AA/4J/AP+FhQD/hX8A/4V+AP+EfwD/g4AA/4Z+AP+HfgD/gnwA/4d/AP+GggD/iYcA/4mEAP+IhAD/hnwA/4l3AP+GjgD/h34A/4uAAP+MhAD/ioIA/4yDAP+NfgD/j4AA/4yBAP+NgwD/i4AA/4t/AP+OggD/jYIA/42BAP+MfwD/joQA/5GCAP+RfwD/jn4A/4+BAP+VhQD/lIIA/5GEAP+QfgD/j4MA/46BAP+SgwD/kH4A/4+AAP+MgAD/i30A/4p/AP+MgAD/i3oA/4mAAP+PfwD/kIMA/457AP+SgAD/koIA/5GAAP+SgwD/kIAA/5F/AP+PfgD/j34A/5F/AP+QgAD/koMA/5GAAP+SggD/koAA/457AP+QgwD/j38A/4mAAP+LegD/jIAA/4p/AP+LfQD/jIAA/4+AAP+QfgD/koMA/46BAP+PgwD/kH4A/5GEAP+UggD/lYUA/4+BAP+OfgD/kX8A/5GCAP+OhAD/jH8A/42BAP+NggD/joIA/4t/AP+LgAD/jYMA/4yBAP+PgAD/jX4A/4yDAP+KggD/jIQA/4uAAP+HfgD/ho4A/4l3AP+GfAD/iIQA/4mEAP+JhwD/hoIA/4d/AP+CfAD/h34A/4Z+AP+DgAD/hH8A/4V+AP+FfwD/hYUA/4J/AP+DgAD/gX0A/4F/AP+BfgD/gn8A/4GAAP9/fgD/fX8A/3+AAP9/fAD/gYEA/4F9AP+DggD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CCAP+CgAD/gX8A/4J9AP9/gAD/gIIA/4CAAP+AgAD/gIEA/4KDAP+BfgD/gYQA/4R/AP+CggD/g4YA/4WDAP+DgAD/hIQA/4V7AP+CfAD/hoIA/4Z8AP+FfwD/g4IA/4SDAP+GfgD/iYEA/4p+AP+HewD/i4kA/4eAAP+KfQD/h3wA/4Z+AP+JggD/ioEA/4x/AP+NfwD/jIAA/42EAP+NhgD/jYMA/42AAP+QgwD/jH8A/46EAP+OhAD/j30A/4+CAP+QfwD/koMA/5SBAP+PgAD/j3wA/49+AP+PfwD/lH4A/4qDAP+OfwD/jIQA/4l+AP+JfgD/jX8A/459AP+LfAD/kYMA/46BAP+QfwD/j34A/4+DAP+OfgD/joEA/4+BAP+NggD/i4MA/4uDAP+NggD/j4EA/46BAP+OfgD/j4MA/49+AP+QfwD/joEA/5GDAP+LfAD/jn0A/41/AP+JfgD/iX4A/4yEAP+OfwD/ioMA/5R+AP+PfwD/j34A/498AP+PgAD/lIEA/5KDAP+QfwD/j4IA/499AP+OhAD/joQA/4x/AP+QgwD/jYAA/42DAP+NhgD/jYQA/4yAAP+NfwD/jH8A/4qBAP+JggD/hn4A/4d8AP+KfQD/h4AA/4uJAP+HewD/in4A/4mBAP+GfgD/hIMA/4OCAP+FfwD/hnwA/4aCAP+CfAD/hXsA/4SEAP+DgAD/hYMA/4OGAP+CggD/hH8A/4GEAP+BfgD/goMA/4CBAP+AgAD/gIAA/4CCAP9/gAD/gn0A/4F/AP+CgAD/gIIA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gYEA/359AP+BhAD/fn4A/36EAP+BfgD/gH4A/4B/AP+BggD/gn8A/4F+AP+DfwD/g4QA/4ODAP+EhQD/g34A/4SDAP+GgwD/goAA/4SCAP+EfQD/gH0A/4d/AP+FfwD/hoAA/4WFAP+IggD/iYEA/4l+AP+LgAD/i4UA/4aEAP+GggD/hoAA/4l9AP+MggD/i4AA/4t9AP+KfAD/i3kA/41/AP+NggD/in0A/4mEAP+MfwD/jH8A/41/AP+MgQD/j4EA/5J9AP+TgwD/jX0A/4+AAP+QfQD/kH4A/5GCAP+LfgD/jYYA/4t+AP+MgwD/jIIA/4h9AP+KgwD/jYAA/459AP+OggD/jYIA/46CAP+NfgD/jYEA/4yDAP+LhgD/i4MA/4yDAP+MgwD/i4MA/4uGAP+MgwD/jYEA/41+AP+OggD/jYIA/46CAP+OfQD/jYAA/4qDAP+IfQD/jIIA/4yDAP+LfgD/jYYA/4t+AP+RggD/kH4A/5B9AP+PgAD/jX0A/5ODAP+SfQD/j4EA/4yBAP+NfwD/jH8A/4x/AP+JhAD/in0A/42CAP+NfwD/i3kA/4p8AP+LfQD/i4AA/4yCAP+JfQD/hoAA/4aCAP+GhAD/i4UA/4uAAP+JfgD/iYEA/4iCAP+FhQD/hoAA/4V/AP+HfwD/gH0A/4R9AP+EggD/goAA/4aDAP+EgwD/g34A/4SFAP+DgwD/g4QA/4N/AP+BfgD/gn8A/4GCAP+AfwD/gH4A/4F+AP9+hAD/fn4A/4GEAP9+fQD/gYEA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfwD/fYAA/36BAP99fgD/fn0A/4CEAP9/gAD/gn4A/4B+AP+BgAD/gIMA/4CBAP+CgQD/gX4A/4SCAP+CfgD/hYEA/4OGAP+DgAD/hoAA/4aBAP+GggD/hoAA/4Z/AP+FggD/hX4A/4mCAP+JgQD/iYIA/4iCAP+HgwD/iYQA/4Z7AP+IfwD/jH0A/46DAP+RgQD/i3wA/4x+AP+OgQD/ioUA/4mEAP+KfQD/kIMA/42BAP+NfwD/joMA/4+AAP+RggD/lIEA/5KCAP+RgQD/joAA/46GAP+NfgD/jH8A/4p/AP+MewD/jH0A/498AP+LgQD/h4AA/4h9AP+JgAD/jYIA/5F/AP+OgQD/jYEA/4t9AP+LfgD/in8A/46DAP+PfgD/j34A/46DAP+KfwD/i34A/4t9AP+NgQD/joEA/5F/AP+NggD/iYAA/4h9AP+HgAD/i4EA/498AP+MfQD/jHsA/4p/AP+MfwD/jX4A/46GAP+OgAD/kYEA/5KCAP+UgQD/kYIA/4+AAP+OgwD/jX8A/42BAP+QgwD/in0A/4mEAP+KhQD/joEA/4x+AP+LfAD/kYEA/46DAP+MfQD/iH8A/4Z7AP+JhAD/h4MA/4iCAP+JggD/iYEA/4mCAP+FfgD/hYIA/4Z/AP+GgAD/hoIA/4aBAP+GgAD/g4AA/4OGAP+FgQD/gn4A/4SCAP+BfgD/goEA/4CBAP+AgwD/gYAA/4B+AP+CfgD/f4AA/4CEAP9+fQD/fX4A/36BAP99gAD/gH8A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/319AP99ggD/gYMA/399AP9+ggD/f4AA/4B9AP+BgQD/gXwA/39+AP+BhQD/gH4A/36CAP+CgAD/hH4A/4aEAP+FegD/hoAA/4WAAP+IfwD/g4EA/4J+AP+HewD/goEA/4eDAP+HhQD/hXwA/4eAAP+HfwD/iX4A/4mBAP+LfwD/i4EA/42FAP+NfwD/jYYA/42EAP+OgAD/jYMA/4aFAP+KhQD/jYIA/42AAP+NggD/j38A/5J/AP+QhAD/j4QA/5J/AP+SewD/k4IA/41+AP+LfgD/ioAA/4l+AP+KgAD/jnwA/4+DAP+OfgD/in8A/4qBAP+KfQD/in4A/4p+AP+NhgD/i4IA/5B+AP+KfwD/iYgA/4qAAP+MgwD/jH4A/4x+AP+MgwD/ioAA/4mIAP+KfwD/kH4A/4uCAP+NhgD/in4A/4p+AP+KfQD/ioEA/4p/AP+OfgD/j4MA/458AP+KgAD/iX4A/4qAAP+LfgD/jX4A/5OCAP+SewD/kn8A/4+EAP+QhAD/kn8A/49/AP+NggD/jYAA/42CAP+KhQD/hoUA/42DAP+OgAD/jYQA/42GAP+NfwD/jYUA/4uBAP+LfwD/iYEA/4l+AP+HfwD/h4AA/4V8AP+HhQD/h4MA/4KBAP+HewD/gn4A/4OBAP+IfwD/hYAA/4aAAP+FegD/hoQA/4R+AP+CgAD/foIA/4B+AP+BhQD/f34A/4F8AP+BgQD/gH0A/3+AAP9+ggD/f30A/4GDAP99ggD/fX0A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9+fgD/fIIA/3+DAP99fQD/fYAA/3yBAP9/gAD/gH8A/4KAAP+BfwD/goUA/4SCAP+BfgD/hIEA/4SCAP+HgwD/hoMA/4eCAP+DgQD/hX4A/4R9AP+EgAD/goIA/4F/AP+DhAD/iIEA/4eAAP+KhAD/iIUA/4yFAP+MgQD/i3wA/4x+AP+OfwD/jXwA/4t6AP+LggD/jH0A/5B+AP+NgwD/joEA/41/AP+NgwD/joIA/418AP+QfwD/koAA/5CCAP+QgAD/kn8A/5B8AP+NegD/ioIA/4p+AP+HfgD/iYAA/41+AP+QhQD/jYEA/4yEAP+KgQD/i3sA/4uBAP+IgwD/iX4A/4l5AP+MfgD/iYIA/4qBAP+LhAD/i4MA/4t8AP+LfAD/i4MA/4uEAP+KgQD/iYIA/4x+AP+JeQD/iX4A/4iDAP+LgQD/i3sA/4qBAP+MhAD/jYEA/5CFAP+NfgD/iYAA/4d+AP+KfgD/ioIA/416AP+QfAD/kn8A/5CAAP+QggD/koAA/5B/AP+NfAD/joIA/42DAP+NfwD/joEA/42DAP+QfgD/jH0A/4uCAP+LegD/jXwA/45/AP+MfgD/i3wA/4yBAP+MhQD/iIUA/4qEAP+HgAD/iIEA/4OEAP+BfwD/goIA/4SAAP+EfQD/hX4A/4OBAP+HggD/hoMA/4eDAP+EggD/hIEA/4F+AP+EggD/goUA/4F/AP+CgAD/gH8A/3+AAP98gQD/fYAA/319AP9/gwD/fIIA/35+AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gH8A/35+AP9+gwD/fHwA/3yAAP9/fgD/f4IA/39+AP+AfgD/gIUA/4OBAP+CgwD/gH0A/4J+AP+CgAD/goAA/4aBAP+FegD/h4MA/4V8AP+GfQD/hnsA/4KBAP+GfgD/hn8A/4Z+AP+IfwD/h4UA/4h/AP+IewD/iX8A/418AP+MfQD/joAA/49/AP+OgQD/jYAA/4x/AP+MfQD/joAA/4x+AP+LeQD/jYYA/4t/AP+MgAD/j4EA/4+CAP+OggD/joEA/46AAP+RfwD/joMA/42CAP+NgAD/i4AA/4p9AP+NgQD/j4EA/4p6AP+MhAD/ioAA/4t/AP+PggD/jYQA/4mAAP+MgQD/iX4A/4mCAP+JfQD/iIQA/4h/AP+KhAD/ioQA/4h/AP+IhAD/iX0A/4mCAP+JfgD/jIEA/4mAAP+NhAD/j4IA/4t/AP+KgAD/jIQA/4p6AP+PgQD/jYEA/4p9AP+LgAD/jYAA/42CAP+OgwD/kX8A/46AAP+OgQD/joIA/4+CAP+PgQD/jIAA/4t/AP+NhgD/i3kA/4x+AP+OgAD/jH0A/4x/AP+NgAD/joEA/49/AP+OgAD/jH0A/418AP+JfwD/iHsA/4h/AP+HhQD/iH8A/4Z+AP+GfwD/hn4A/4KBAP+GewD/hn0A/4V8AP+HgwD/hXoA/4aBAP+CgAD/goAA/4J+AP+AfQD/goMA/4OBAP+AhQD/gH4A/39+AP9/ggD/f34A/3yAAP98fAD/foMA/35+AP+AfwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9/fQD/foEA/4B+AP99gQD/fYIA/4GEAP+BggD/gYAA/4CAAP9/fQD/f3sA/4CFAP9/fwD/g4QA/4OCAP+FgAD/hoIA/4WCAP+FfwD/h38A/4Z9AP+FfgD/hoAA/4h9AP+JggD/ioIA/4mBAP+LgAD/iYEA/4uDAP+MfgD/jIQA/42AAP+QgAD/kIAA/4+CAP+NgAD/i4IA/42EAP+LfAD/inwA/42EAP+LgAD/i4YA/417AP+NfQD/jX0A/45+AP+NhQD/jH4A/45+AP+NfgD/joEA/41+AP+OhQD/jYcA/419AP+OgwD/i3oA/4yCAP+MggD/jX8A/4l/AP+JgwD/jXsA/4l7AP+GfwD/iX0A/4uBAP+JggD/h4AA/4eAAP+JggD/i4EA/4l9AP+GfwD/iXsA/417AP+JgwD/iX8A/41/AP+MggD/jIIA/4t6AP+OgwD/jX0A/42HAP+OhQD/jX4A/46BAP+NfgD/jn4A/4x+AP+NhQD/jn4A/419AP+NfQD/jXsA/4uGAP+LgAD/jYQA/4p8AP+LfAD/jYQA/4uCAP+NgAD/j4IA/5CAAP+QgAD/jYAA/4yEAP+MfgD/i4MA/4mBAP+LgAD/iYEA/4qCAP+JggD/iH0A/4aAAP+FfgD/hn0A/4d/AP+FfwD/hYIA/4aCAP+FgAD/g4IA/4OEAP9/fwD/gIUA/397AP9/fQD/gIAA/4GAAP+BggD/gYQA/32CAP99gQD/gH4A/36BAP9/fQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/359AP9/ggD/f4AA/4CAAP9/fAD/gH4A/399AP9+fQD/f4MA/4B/AP+BgAD/gn4A/4J+AP+CgAD/hYEA/4OBAP+DggD/iIIA/4eDAP+FgAD/hn8A/4aAAP+GfgD/iH0A/4mBAP+IfwD/iH4A/4t+AP+KhAD/i4UA/4x+AP+NggD/j4MA/5B9AP+QgAD/joEA/4t6AP+NhgD/kYEA/4t9AP+MgAD/jYMA/4p9AP+LfAD/jn4A/49+AP+PfQD/j4UA/4p+AP+OgAD/joIA/4t9AP+OfgD/kn4A/4yAAP+NgwD/iXkA/4h/AP+LhQD/jIYA/41/AP+KfAD/iIAA/4x/AP+KfgD/h4IA/4t/AP+KhQD/h30A/4mBAP+JgQD/h30A/4qFAP+LfwD/h4IA/4p+AP+MfwD/iIAA/4p8AP+NfwD/jIYA/4uFAP+IfwD/iXkA/42DAP+MgAD/kn4A/45+AP+LfQD/joIA/46AAP+KfgD/j4UA/499AP+PfgD/jn4A/4t8AP+KfQD/jYMA/4yAAP+LfQD/kYEA/42GAP+LegD/joEA/5CAAP+QfQD/j4MA/42CAP+MfgD/i4UA/4qEAP+LfgD/iH4A/4h/AP+JgQD/iH0A/4Z+AP+GgAD/hn8A/4WAAP+HgwD/iIIA/4OCAP+DgQD/hYEA/4KAAP+CfgD/gn4A/4GAAP+AfwD/f4MA/359AP9/fQD/gH4A/398AP+AgAD/f4AA/3+CAP9+fQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfwD/foAA/39+AP+AfwD/gYIA/4GCAP+AfQD/gH8A/35/AP9+fQD/g4AA/4OCAP9/gAD/goQA/4J/AP+DggD/hX0A/4eFAP+FfgD/hoIA/4aBAP+HgAD/hoUA/4Z+AP+KgQD/hn0A/4mAAP+KgwD/iYEA/4Z8AP+KggD/iYIA/46AAP+PgwD/kIAA/49/AP+NfAD/jX8A/46DAP+LgAD/jX8A/4yBAP+OfwD/kIAA/4x/AP+NfwD/jYAA/4yCAP+MfwD/ioEA/42AAP+MgQD/joMA/42GAP+MfQD/jIAA/4uEAP+LgwD/in8A/4uBAP+JeQD/iIAA/4mEAP+LfQD/iooA/4mEAP+IegD/i4gA/4h7AP+IfQD/iH0A/4h7AP+LiAD/iHoA/4mEAP+KigD/i30A/4mEAP+IgAD/iXkA/4uBAP+KfwD/i4MA/4uEAP+MgAD/jH0A/42GAP+OgwD/jIEA/42AAP+KgQD/jH8A/4yCAP+NgAD/jX8A/4x/AP+QgAD/jn8A/4yBAP+NfwD/i4AA/46DAP+NfwD/jXwA/49/AP+QgAD/j4MA/46AAP+JggD/ioIA/4Z8AP+JgQD/ioMA/4mAAP+GfQD/ioEA/4Z+AP+GhQD/h4AA/4aBAP+GggD/hX4A/4eFAP+FfQD/g4IA/4J/AP+ChAD/f4AA/4OCAP+DgAD/fn0A/35/AP+AfwD/gH0A/4GCAP+BggD/gH8A/39+AP9+gAD/gH8A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/359AP9+gQD/gYMA/4KBAP+AggD/gH4A/4B9AP+CgQD/g30A/4SBAP+BggD/fnwA/4KDAP+CfQD/goIA/4N/AP+FfQD/hX8A/4WCAP+HegD/hoEA/4SBAP+IgQD/h4EA/4Z+AP+JfwD/i38A/4l9AP+HfgD/iX8A/4qEAP+JggD/jYIA/42AAP+OgAD/jn8A/42FAP+MfQD/jIIA/4x/AP+PgAD/kn8A/5B8AP+OgQD/jX4A/4mAAP+NgAD/jXkA/419AP+MggD/iYIA/4p9AP+LgQD/i30A/4qCAP+KhQD/hX4A/4t8AP+IfgD/in0A/4iDAP+IfAD/iIIA/4qAAP+HhAD/ioYA/4p9AP+LgAD/iIcA/4iHAP+LgAD/in0A/4qGAP+HhAD/ioAA/4iCAP+IfAD/iIMA/4p9AP+IfgD/i3wA/4V+AP+KhQD/ioIA/4t9AP+LgQD/in0A/4mCAP+MggD/jX0A/415AP+NgAD/iYAA/41+AP+OgQD/kHwA/5J/AP+PgAD/jH8A/4yCAP+MfQD/jYUA/45/AP+OgAD/jYAA/42CAP+JggD/ioQA/4l/AP+HfgD/iX0A/4t/AP+JfwD/hn4A/4eBAP+IgQD/hIEA/4aBAP+HegD/hYIA/4V/AP+FfQD/g38A/4KCAP+CfQD/goMA/358AP+BggD/hIEA/4N9AP+CgQD/gH0A/4B+AP+AggD/goEA/4GDAP9+gQD/fn0A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4B+AP+AfgD/gX0A/4KCAP+AfQD/f4IA/4KDAP+BfgD/gYIA/4CCAP+EgwD/goAA/4OHAP+FgwD/h38A/4aCAP+EfgD/hIAA/4V9AP+IfwD/in4A/4uGAP+JgQD/iX8A/4mDAP+JfwD/ioIA/4x+AP+MhAD/jH0A/4x+AP+LgQD/iH8A/4l9AP+KgQD/jX4A/5CCAP+OfgD/j4IA/5CBAP+NegD/joYA/458AP+NfwD/i4EA/4qFAP+JfwD/i3wA/4uDAP+HfgD/iYEA/4iFAP+LggD/in8A/4mAAP+JggD/in4A/4mCAP+KhQD/h30A/4iBAP+MfwD/jH8A/4iCAP+IggD/jH8A/4x/AP+IgQD/h30A/4qFAP+JggD/in4A/4mCAP+JgAD/in8A/4uCAP+IhQD/iYEA/4d+AP+LgwD/i3wA/4l/AP+KhQD/i4EA/41/AP+OfAD/joYA/416AP+QgQD/j4IA/45+AP+QggD/jX4A/4qBAP+JfQD/iH8A/4uBAP+MfgD/jH0A/4yEAP+MfgD/ioIA/4l/AP+JgwD/iX8A/4mBAP+LhgD/in4A/4h/AP+FfQD/hIAA/4R+AP+GggD/h38A/4WDAP+DhwD/goAA/4SDAP+AggD/gYIA/4F+AP+CgwD/f4IA/4B9AP+CggD/gX0A/4B+AP+AfgD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4B/AP+AfgD/fX8A/39+AP+AfgD/gIMA/35/AP+AfwD/gIEA/4GBAP+BgAD/hIIA/4SCAP+FgQD/g30A/4R9AP+GfwD/h4AA/4iCAP+GfQD/ioAA/4qCAP+JfwD/h34A/4Z8AP+LhQD/jH4A/418AP+LfAD/i38A/4Z7AP+GgAD/iYIA/4yDAP+NgAD/kIQA/5CGAP+NfQD/joMA/5B/AP+NfgD/ioYA/4uAAP+IewD/i4UA/4l+AP+JfwD/iYEA/4mCAP+GfQD/h4EA/4uAAP+HhAD/iYIA/4x6AP+LfgD/iHwA/4iAAP+KgAD/iH4A/4x9AP+LgwD/i4MA/4x9AP+IfgD/ioAA/4iAAP+IfAD/i34A/4x6AP+JggD/h4QA/4uAAP+HgQD/hn0A/4mCAP+JgQD/iX8A/4l+AP+LhQD/iHsA/4uAAP+KhgD/jX4A/5B/AP+OgwD/jX0A/5CGAP+QhAD/jYAA/4yDAP+JggD/hoAA/4Z7AP+LfwD/i3wA/418AP+MfgD/i4UA/4Z8AP+HfgD/iX8A/4qCAP+KgAD/hn0A/4iCAP+HgAD/hn8A/4R9AP+DfQD/hYEA/4SCAP+EggD/gYAA/4GBAP+AgQD/gH8A/35/AP+AgwD/gH4A/39+AP99fwD/gH4A/4B/AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CCAP+AggD/goQA/4CBAP+BfgD/goQA/4J+AP+BggD/gXwA/4B9AP+ChQD/gIIA/4B/AP+EgwD/hYIA/4aAAP+GgAD/hX8A/4V+AP+FfgD/hn8A/4d/AP+KgAD/iYEA/4l9AP+JgQD/ioQA/4uDAP+JfwD/jIEA/4mBAP+JhAD/hoIA/4Z+AP+KggD/i34A/4mDAP+LhQD/j4UA/4yBAP+OgAD/iIAA/4mGAP+GfwD/hoMA/4mDAP+LggD/jYUA/4yCAP+LggD/iYEA/4aAAP+JhgD/hoEA/4R9AP+IegD/hn0A/4aFAP+GgQD/h30A/4uEAP+KfgD/jIMA/4yDAP+KfgD/i4QA/4d9AP+GgQD/hoUA/4Z9AP+IegD/hH0A/4aBAP+JhgD/hoAA/4mBAP+LggD/jIIA/42FAP+LggD/iYMA/4aDAP+GfwD/iYYA/4iAAP+OgAD/jIEA/4+FAP+LhQD/iYMA/4t+AP+KggD/hn4A/4aCAP+JhAD/iYEA/4yBAP+JfwD/i4MA/4qEAP+JgQD/iX0A/4mBAP+KgAD/h38A/4Z/AP+FfgD/hX4A/4V/AP+GgAD/hoAA/4WCAP+EgwD/gH8A/4CCAP+ChQD/gH0A/4F8AP+BggD/gn4A/4KEAP+BfgD/gIEA/4KEAP+AggD/gIIA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+BggD/gIMA/4OBAP+CggD/gX4A/39+AP+AfgD/gYIA/4F+AP+AfwD/gYAA/4F/AP+DfAD/gn0A/4KDAP+HgQD/g4IA/4SCAP+EgQD/hIMA/4R+AP+GfwD/hn0A/4uGAP+LfwD/ioMA/4t+AP+JgQD/iHsA/4yFAP+JfgD/h4MA/4aEAP+HfAD/jIQA/4t/AP+LggD/iX8A/4uCAP+GgAD/iIAA/4iEAP+JfwD/hoIA/4iEAP+HgwD/iYYA/4p/AP+KgQD/iYEA/4l/AP+JfwD/inoA/4l9AP+HggD/iYUA/4Z/AP+GgAD/h4AA/4aCAP+IfwD/jH0A/42DAP+NgwD/jH0A/4h/AP+GggD/h4AA/4aAAP+GfwD/iYUA/4eCAP+JfQD/inoA/4l/AP+JfwD/iYEA/4qBAP+KfwD/iYYA/4eDAP+IhAD/hoIA/4l/AP+IhAD/iIAA/4aAAP+LggD/iX8A/4uCAP+LfwD/jIQA/4d8AP+GhAD/h4MA/4l+AP+MhQD/iHsA/4mBAP+LfgD/ioMA/4t/AP+LhgD/hn0A/4Z/AP+EfgD/hIMA/4SBAP+EggD/g4IA/4eBAP+CgwD/gn0A/4N8AP+BfwD/gYAA/4B/AP+BfgD/gYIA/4B+AP9/fgD/gX4A/4KCAP+DgQD/gIMA/4GCAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfgD/fn8A/3+BAP+CgwD/goMA/4R/AP9/fQD/fXwA/3+BAP9/fwD/gX0A/4J+AP+CfQD/g30A/4GDAP+DgwD/gn8A/4OCAP+DfwD/g3sA/4SFAP+EgwD/hX4A/4iCAP+KfgD/iX8A/4mAAP+IfgD/i4AA/4h/AP+IhQD/h38A/4iCAP+LhQD/in0A/4uAAP+LgwD/iX4A/4qCAP+NfQD/iH0A/4mCAP+GgQD/iX8A/4R+AP+EggD/iH8A/4l/AP+LggD/ioAA/4WEAP+HgQD/iogA/4qCAP+JgwD/g4EA/4WDAP+GfgD/iIYA/4WDAP+KgAD/jX8A/4x+AP+NfQD/jX0A/4x+AP+NfwD/ioAA/4WDAP+IhgD/hn4A/4WDAP+DgQD/iYMA/4qCAP+KiAD/h4EA/4WEAP+KgAD/i4IA/4l/AP+IfwD/hIIA/4R+AP+JfwD/hoEA/4mCAP+IfQD/jX0A/4qCAP+JfgD/i4MA/4uAAP+KfQD/i4UA/4iCAP+HfwD/iIUA/4h/AP+LgAD/iH4A/4mAAP+JfwD/in4A/4iCAP+FfgD/hIMA/4SFAP+DewD/g38A/4OCAP+CfwD/g4MA/4GDAP+DfQD/gn0A/4J+AP+BfQD/f38A/3+BAP99fAD/f30A/4R/AP+CgwD/goMA/3+BAP9+fwD/gH4A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/fn8A/39/AP9/fwD/f4EA/4CBAP+AgQD/g4AA/4J9AP9/fwD/hIMA/4N8AP+EgAD/hIEA/4R/AP+CgQD/gX4A/4CBAP+EhAD/g4AA/4KBAP+DewD/hIEA/4V+AP+HgAD/iH8A/4Z+AP+GfQD/iH8A/4mBAP+HhQD/ioQA/4eAAP+JggD/i4AA/4eAAP+HfgD/ioQA/4eCAP+JhQD/i4EA/4qCAP+MgQD/hX8A/4eAAP+CfwD/g3wA/4eGAP+IgwD/ioYA/4uDAP+GewD/hn8A/4l9AP+KfQD/iIIA/4SAAP+GfAD/iH4A/4uHAP+GhAD/iX4A/46GAP+OgQD/joAA/46AAP+OgQD/joYA/4l+AP+GhAD/i4cA/4h+AP+GfAD/hIAA/4iCAP+KfQD/iX0A/4Z/AP+GewD/i4MA/4qGAP+IgwD/h4YA/4N8AP+CfwD/h4AA/4V/AP+MgQD/ioIA/4uBAP+JhQD/h4IA/4qEAP+HfgD/h4AA/4uAAP+JggD/h4AA/4qEAP+HhQD/iYEA/4h/AP+GfQD/hn4A/4h/AP+HgAD/hX4A/4SBAP+DewD/goEA/4OAAP+EhAD/gIEA/4F+AP+CgQD/hH8A/4SBAP+EgAD/g3wA/4SDAP9/fwD/gn0A/4OAAP+AgQD/gIEA/3+BAP9/fwD/f38A/35/AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/3+DAP9+fgD/foIA/39/AP+AhAD/gYIA/4KCAP+DgAD/gn8A/4OCAP+EfgD/g34A/4KAAP+EhQD/hIIA/4J+AP9/fgD/gn4A/4N9AP+DgAD/g38A/4SCAP+FfwD/hn8A/4V9AP+HgQD/ioEA/4mBAP+KggD/iH8A/4eAAP+FfAD/iYEA/4l+AP+LiQD/ho4A/4d+AP+GgwD/h4AA/4d5AP+LgAD/iIEA/4l1AP+EgQD/gXsA/4d8AP+IgAD/hYAA/4mDAP+JggD/in4A/4aEAP+MgAD/i4gA/4d/AP+IhQD/iIUA/4eCAP+GgAD/hX0A/4iDAP+KgQD/in0A/4qCAP+KggD/in0A/4qBAP+IgwD/hX0A/4aAAP+HggD/iIUA/4iFAP+HfwD/i4gA/4yAAP+GhAD/in4A/4mCAP+JgwD/hYAA/4iAAP+HfAD/gXsA/4SBAP+JdQD/iIEA/4uAAP+HeQD/h4AA/4aDAP+HfgD/ho4A/4uJAP+JfgD/iYEA/4V8AP+HgAD/iH8A/4qCAP+JgQD/ioEA/4eBAP+FfQD/hn8A/4V/AP+EggD/g38A/4OAAP+DfQD/gn4A/39+AP+CfgD/hIIA/4SFAP+CgAD/g34A/4R+AP+DggD/gn8A/4OAAP+CggD/gYIA/4CEAP9/fwD/foIA/35+AP9/gwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9+ggD/gIQA/39/AP9/ggD/f34A/4GDAP+AgQD/gX4A/4KDAP+CgAD/gn4A/4WCAP+CfQD/hYIA/4eAAP+FfwD/f4AA/4GCAP+CfgD/hIQA/4OCAP+DggD/hoAA/4R9AP+EgAD/iIEA/4Z+AP+IfQD/iYIA/4Z+AP+IgQD/h4UA/4mCAP+JgQD/h3sA/4l3AP+IfgD/h30A/4h+AP+KhQD/in0A/4eBAP+JggD/h4EA/4Z+AP+IggD/hXsA/4d/AP+LfQD/iX4A/4mHAP+JgwD/jIYA/4t9AP+LhQD/h4AA/4R9AP+HggD/h30A/4eFAP+IgQD/h4MA/4mBAP+IfAD/iHwA/4mBAP+HgwD/iIEA/4eFAP+HfQD/h4IA/4R9AP+HgAD/i4UA/4t9AP+MhgD/iYMA/4mHAP+JfgD/i30A/4d/AP+FewD/iIIA/4Z+AP+HgQD/iYIA/4eBAP+KfQD/ioUA/4h+AP+HfQD/iH4A/4l3AP+HewD/iYEA/4mCAP+HhQD/iIEA/4Z+AP+JggD/iH0A/4Z+AP+IgQD/hIAA/4R9AP+GgAD/g4IA/4OCAP+EhAD/gn4A/4GCAP9/gAD/hX8A/4eAAP+FggD/gn0A/4WCAP+CfgD/goAA/4KDAP+BfgD/gIEA/4GDAP9/fgD/f4IA/39/AP+AhAD/foIA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/fn0A/36BAP9/gwD/gIMA/39+AP9+fgD/gIAA/4J/AP+BfgD/gYIA/4N+AP+CfQD/hH8A/4aCAP+EgQD/gn4A/4F9AP9/gAD/f34A/4CBAP+CfwD/h4EA/4aAAP+DfQD/hH4A/4SBAP+GhQD/hn4A/4h9AP+GfwD/g4QA/4eDAP+FfgD/iIIA/4p+AP+GfAD/h4MA/4h9AP+JfgD/h4YA/4uCAP+JgQD/hnwA/4Z+AP+HfgD/iIUA/4d9AP+MgAD/iYEA/4mDAP+JfAD/ioMA/4yGAP+KgAD/hoAA/4eDAP+EfAD/hoEA/4V/AP+GgQD/hn4A/4SAAP+HgwD/iH4A/4h+AP+HgwD/hIAA/4Z+AP+GgQD/hX8A/4aBAP+EfAD/h4MA/4aAAP+KgAD/jIYA/4qDAP+JfAD/iYMA/4mBAP+MgAD/h30A/4iFAP+HfgD/hn4A/4Z8AP+JgQD/i4IA/4eGAP+JfgD/iH0A/4eDAP+GfAD/in4A/4iCAP+FfgD/h4MA/4OEAP+GfwD/iH0A/4Z+AP+GhQD/hIEA/4R+AP+DfQD/hoAA/4eBAP+CfwD/gIEA/39+AP9/gAD/gX0A/4J+AP+EgQD/hoIA/4R/AP+CfQD/g34A/4GCAP+BfgD/gn8A/4CAAP9+fgD/f34A/4CDAP9/gwD/foEA/359AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+CgAD/gX4A/4KBAP+DggD/g38A/4R/AP+FfwD/hIQA/4N8AP+CfgD/hX8A/4J+AP+BfgD/g4MA/4KDAP+FggD/hYEA/4aCAP+GgQD/h4AA/4aAAP+GgAD/hn4A/4F/AP+CgQD/hYIA/4WFAP+JgQD/iIQA/4l/AP+OfgD/ioEA/4d9AP+GfAD/iH8A/4h+AP+IhQD/insA/42EAP+LhAD/ioYA/4eAAP+JfwD/ioIA/4eDAP+LfQD/iH8A/4eAAP+IgwD/hXoA/4eCAP+FfQD/iYEA/4h/AP+IfQD/in8A/4WCAP+FggD/in8A/4h9AP+IfwD/iYEA/4V9AP+HggD/hXoA/4iDAP+HgAD/iH8A/4t9AP+HgwD/ioIA/4l/AP+HgAD/ioYA/4uEAP+NhAD/insA/4iFAP+IfgD/iH8A/4Z8AP+HfQD/ioEA/45+AP+JfwD/iIQA/4mBAP+FhQD/hYIA/4KBAP+BfwD/hn4A/4aAAP+GgAD/h4AA/4aBAP+GggD/hYEA/4WCAP+CgwD/g4MA/4F+AP+CfgD/hX8A/4J+AP+DfAD/hIQA/4V/AP+EfwD/g38A/4OCAP+CgQD/gX4A/4KAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIIA/4KBAP+DfwD/hYIA/4SBAP+DfAD/hH8A/4WCAP+EhAD/hIEA/4eAAP+EggD/goEA/4GDAP+CfQD/hIMA/4SCAP+HfwD/h3oA/4aBAP+GfwD/hX4A/4KBAP+CggD/h3sA/4Z/AP+GgAD/hn4A/4mEAP+KggD/jn0A/4uCAP+JgQD/iYEA/4t/AP+MggD/jHwA/4aBAP+IewD/h4QA/4Z8AP+IhAD/ioQA/4WAAP+GggD/h4gA/4eFAP+HfQD/h4AA/4d/AP+FgAD/h4QA/4h7AP+IgAD/hoAA/4Z8AP+GhQD/hoUA/4Z8AP+GgAD/iIAA/4h7AP+HhAD/hYAA/4d/AP+HgAD/h30A/4eFAP+HiAD/hoIA/4WAAP+KhAD/iIQA/4Z8AP+HhAD/iHsA/4aBAP+MfAD/jIIA/4t/AP+JgQD/iYEA/4uCAP+OfQD/ioIA/4mEAP+GfgD/hoAA/4Z/AP+HewD/goIA/4KBAP+FfgD/hn8A/4aBAP+HegD/h38A/4SCAP+EgwD/gn0A/4GDAP+CgQD/hIIA/4eAAP+EgQD/hIQA/4WCAP+EfwD/g3wA/4SBAP+FggD/g38A/4KBAP+AggD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+BgwD/goEA/4F9AP+DgwD/hYMA/4SCAP+EfwD/hX8A/4aCAP+FggD/hIUA/4R/AP+DfQD/g3wA/4B/AP+EggD/hYMA/4WCAP+GggD/hYAA/4Z9AP+GewD/hIAA/4J+AP+GgAD/hX8A/4SDAP+JhwD/i38A/4mFAP+LgwD/iYIA/4d+AP+JgQD/jIUA/4eBAP+KfwD/hn8A/4iCAP+JhAD/hHwA/4SAAP+GgAD/h3wA/4h/AP+IgQD/iYMA/4SAAP+HhgD/iX8A/4V9AP+HgAD/iYEA/4eCAP+IhQD/g3wA/4N8AP+IhQD/h4IA/4mBAP+HgAD/hX0A/4l/AP+HhgD/hIAA/4mDAP+IgQD/iH8A/4d8AP+GgAD/hIAA/4R8AP+JhAD/iIIA/4Z/AP+KfwD/h4EA/4yFAP+JgQD/h34A/4mCAP+LgwD/iYUA/4t/AP+JhwD/hIMA/4V/AP+GgAD/gn4A/4SAAP+GewD/hn0A/4WAAP+GggD/hYIA/4WDAP+EggD/gH8A/4N8AP+DfQD/hH8A/4SFAP+FggD/hoIA/4V/AP+EfwD/hIIA/4WDAP+DgwD/gX0A/4KBAP+BgwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4GDAP+CgQD/gX0A/4KCAP+FgwD/g3wA/4R/AP+EfwD/gn0A/4KAAP+EgQD/gn0A/4F/AP+AggD/gYAA/4OHAP+FfwD/hX4A/4eDAP+HfwD/hn0A/4R9AP+DgQD/hoIA/4d/AP+DggD/hoIA/4mCAP+JegD/iIIA/4iDAP+HgQD/hX8A/4mFAP+JggD/iYEA/4Z/AP+FgAD/g3sA/4aCAP+IfwD/iX8A/4mBAP+IgwD/hX4A/4J9AP+AegD/h4QA/4eAAP+IiAD/iIEA/4qAAP+GgQD/hXoA/4WBAP+FgQD/hXoA/4aBAP+KgAD/iIEA/4iIAP+HgAD/h4QA/4B6AP+CfQD/hX4A/4iDAP+JgQD/iX8A/4h/AP+GggD/g3sA/4WAAP+GfwD/iYEA/4mCAP+JhQD/hX8A/4eBAP+IgwD/iIIA/4l6AP+JggD/hoIA/4OCAP+HfwD/hoIA/4OBAP+EfQD/hn0A/4d/AP+HgwD/hX4A/4V/AP+DhwD/gYAA/4CCAP+BfwD/gn0A/4SBAP+CgAD/gn0A/4R/AP+EfwD/g3wA/4WDAP+CggD/gX0A/4KBAP+BgwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gYMA/4KBAP+BfQD/g4MA/4SBAP+DfwD/gn0A/4WCAP+DfgD/hIAA/4J+AP+BgAD/goUA/4GBAP+CgAD/hX0A/4eFAP+IggD/hX8A/4V8AP+FfgD/iH8A/4aBAP+AfQD/hX8A/4d/AP+IgwD/hnwA/4eHAP+GggD/in4A/4J9AP+GfAD/ioIA/4l/AP+IhQD/hoMA/4Z+AP+HgAD/iH8A/4iDAP+JfQD/hoIA/4R+AP+EfgD/hIMA/4SHAP+FhQD/gn8A/4h/AP+HgwD/hoIA/4aDAP+GgQD/hoEA/4aDAP+GggD/h4MA/4h/AP+CfwD/hYUA/4SHAP+EgwD/hH4A/4R+AP+GggD/iX0A/4iDAP+IfwD/h4AA/4Z+AP+GgwD/iIUA/4l/AP+KggD/hnwA/4J9AP+KfgD/hoIA/4eHAP+GfAD/iIMA/4d/AP+FfwD/gH0A/4aBAP+IfwD/hX4A/4V8AP+FfwD/iIIA/4eFAP+FfQD/goAA/4GBAP+ChQD/gYAA/4J+AP+EgAD/g34A/4WCAP+CfQD/g38A/4SBAP+DgwD/gX0A/4KBAP+BgwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+BgwD/goEA/4F9AP+FggD/g4IA/4N+AP+CfgD/hH4A/4N8AP+BfQD/gH8A/4B9AP+AgQD/hIMA/4N/AP+FfQD/g4IA/4WCAP+HgwD/g4EA/4WAAP+GgAD/hH0A/4Z8AP+CfAD/hYIA/4aGAP+FgAD/hX4A/4Z/AP+IfwD/iX4A/4t/AP+FfwD/hn8A/4h+AP+IfgD/h4IA/4mCAP+IhgD/hn8A/4SBAP+CfwD/g4AA/4J+AP+BfgD/gH8A/4F/AP+FhAD/hXsA/4d/AP+GfgD/hXsA/4V7AP+GfgD/h38A/4V7AP+FhAD/gX8A/4B/AP+BfgD/gn4A/4OAAP+CfwD/hIEA/4Z/AP+IhgD/iYIA/4eCAP+IfgD/iH4A/4Z/AP+FfwD/i38A/4l+AP+IfwD/hn8A/4V+AP+FgAD/hoYA/4WCAP+CfAD/hnwA/4R9AP+GgAD/hYAA/4OBAP+HgwD/hYIA/4OCAP+FfQD/g38A/4SDAP+AgQD/gH0A/4B/AP+BfQD/g3wA/4R+AP+CfgD/g34A/4OCAP+FggD/gX0A/4KBAP+BgwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4GDAP+CgQD/g38A/4KBAP+BggD/goAA/4OCAP+EgwD/f38A/4F+AP+BfAD/gH8A/4CCAP+CggD/g4IA/4OBAP+GggD/hXoA/4eCAP+GgAD/g4AA/4SCAP+GggD/h34A/4Z7AP+GgQD/hoIA/4aAAP+FegD/hoIA/4eEAP+KfwD/iIAA/4Z5AP+JggD/ioQA/4iAAP+IfwD/hoYA/4WBAP+BfgD/gYMA/4SCAP+AfgD/gX4A/4SAAP+CfQD/gnwA/4eEAP+IggD/h4YA/4J/AP+CfwD/h4YA/4iCAP+HhAD/gnwA/4J9AP+EgAD/gX4A/4B+AP+EggD/gYMA/4F+AP+FgQD/hoYA/4h/AP+IgAD/ioQA/4mCAP+GeQD/iIAA/4p/AP+HhAD/hoIA/4V6AP+GgAD/hoIA/4aBAP+GewD/h34A/4aCAP+EggD/g4AA/4aAAP+HggD/hXoA/4aCAP+DgQD/g4IA/4KCAP+AggD/gH8A/4F8AP+BfgD/f38A/4SDAP+DggD/goAA/4GCAP+CgQD/g38A/4KBAP+BgwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gYMA/4KBAP+BfgD/gX4A/4KDAP+CfwD/f38A/3+BAP+BggD/gYIA/35/AP+BggD/gn0A/4J/AP+FgQD/hYAA/4aBAP+GgwD/hXoA/4OGAP+CgAD/gnwA/4Z+AP+GgQD/hH4A/4V+AP+GfgD/g38A/4eBAP+HgQD/hYQA/4iEAP+EgAD/iIEA/4Z/AP+HgQD/iH8A/4V/AP+EfgD/gn4A/4R8AP+DfAD/gH8A/4B+AP+EhQD/g34A/4WAAP+GfgD/h30A/4eDAP+KgQD/ioEA/4eDAP+HfQD/hn4A/4WAAP+DfgD/hIUA/4B+AP+AfwD/g3wA/4R8AP+CfgD/hH4A/4V/AP+IfwD/h4EA/4Z/AP+IgQD/hIAA/4iEAP+FhAD/h4EA/4eBAP+DfwD/hn4A/4V+AP+EfgD/hoEA/4Z+AP+CfAD/goAA/4OGAP+FegD/hoMA/4aBAP+FgAD/hYEA/4J/AP+CfQD/gYIA/35/AP+BggD/gYIA/3+BAP9/fwD/gn8A/4KDAP+BfgD/gX4A/4KBAP+BgwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AggD/goAA/4J/AP+BfgD/g4AA/4J9AP99fAD/gH4A/4J+AP+AgwD/gX4A/4KDAP+ChAD/goAA/4OCAP+CgAD/h4MA/4aEAP+FgQD/hoMA/4V7AP+DgAD/hH4A/4N8AP+FfQD/hYAA/4SCAP+IfQD/h4QA/4Z6AP+HhAD/hn4A/4d6AP+IfwD/hn4A/4WCAP+DgwD/hYEA/4R7AP+EgwD/hIUA/4OGAP+CfwD/hYMA/4SDAP+HewD/hH0A/4p+AP+EggD/hoAA/4aAAP+EggD/in4A/4R9AP+HewD/hIMA/4WDAP+CfwD/g4YA/4SFAP+EgwD/hHsA/4WBAP+DgwD/hYIA/4Z+AP+IfwD/h3oA/4Z+AP+HhAD/hnoA/4eEAP+IfQD/hIIA/4WAAP+FfQD/g3wA/4R+AP+DgAD/hXsA/4aDAP+FgQD/hoQA/4eDAP+CgAD/g4IA/4KAAP+ChAD/goMA/4F+AP+AgwD/gn4A/4B+AP99fAD/gn0A/4OAAP+BfgD/gn8A/4KAAP+AggD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIEA/4KCAP+DgAD/f30A/39+AP+ChAD/gH4A/4KDAP9+fAD/f4AA/4J+AP+DhAD/goAA/4SCAP+EfgD/gn4A/4SDAP+EhAD/hH8A/4WAAP+EfgD/hH0A/4R9AP+IfgD/hX4A/4V+AP+GhAD/hHwA/4d4AP+GgwD/iH4A/4iAAP+FfgD/hIAA/4N7AP+DgwD/hX0A/4KGAP+BggD/g30A/4N7AP+DhAD/hn4A/4eBAP+IfQD/h4AA/4eBAP+HgQD/h4AA/4h9AP+HgQD/hn4A/4OEAP+DewD/g30A/4GCAP+ChgD/hX0A/4ODAP+DewD/hIAA/4V+AP+IgAD/iH4A/4aDAP+HeAD/hHwA/4aEAP+FfgD/hX4A/4h+AP+EfQD/hH0A/4R+AP+FgAD/hH8A/4SEAP+EgwD/gn4A/4R+AP+EggD/goAA/4OEAP+CfgD/f4AA/358AP+CgwD/gH4A/4KEAP9/fgD/f30A/4OAAP+CggD/gIEA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/fn4A/4GDAP+BggD/gIEA/4R/AP+BfgD/gX4A/39+AP9/ggD/gYIA/4OCAP+CfgD/f38A/4J+AP+EgQD/goAA/4SCAP+DfgD/g4AA/4V+AP+GgAD/hIEA/4Z7AP+HegD/iX8A/4uEAP+HgwD/hoMA/4eBAP+HggD/hIAA/4iEAP+IfgD/h4EA/4N8AP+DgAD/hH4A/4WAAP+DgwD/gH0A/4SDAP+FgQD/g38A/4iEAP+FgQD/h3wA/4iIAP+HgQD/h4EA/4iIAP+HfAD/hYEA/4iEAP+DfwD/hYEA/4SDAP+AfQD/g4MA/4WAAP+EfgD/g4AA/4N8AP+HgQD/iH4A/4iEAP+EgAD/h4IA/4eBAP+GgwD/h4MA/4uEAP+JfwD/h3oA/4Z7AP+EgQD/hoAA/4V+AP+DgAD/g34A/4SCAP+CgAD/hIEA/4J+AP9/fwD/gn4A/4OCAP+BggD/f4IA/39+AP+BfgD/gX4A/4R/AP+AgQD/gYIA/4GDAP9+fgD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/39+AP9/fgD/gIQA/4CBAP+CgwD/goIA/4CBAP99fwD/gH0A/4SBAP+DgAD/gYAA/4CFAP+AfQD/gX4A/36CAP+BfgD/hIUA/4WDAP+FfwD/g30A/4WDAP+IgQD/h34A/4iDAP+JhAD/hX0A/4WBAP+HhQD/hYAA/4eCAP+JfQD/iYAA/4eDAP+FgwD/h4MA/4CAAP+DfgD/g4AA/4V+AP+EfgD/g34A/4KCAP+FhQD/hYAA/4WAAP+EgQD/g4EA/4OBAP+EgQD/hYAA/4WAAP+FhQD/goIA/4N+AP+EfgD/hX4A/4OAAP+DfgD/gIAA/4eDAP+FgwD/h4MA/4mAAP+JfQD/h4IA/4WAAP+HhQD/hYEA/4V9AP+JhAD/iIMA/4d+AP+IgQD/hYMA/4N9AP+FfwD/hYMA/4SFAP+BfgD/foIA/4F+AP+AfQD/gIUA/4GAAP+DgAD/hIEA/4B9AP99fwD/gIEA/4KCAP+CgwD/gIEA/4CEAP9/fgD/f34A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgwD/f4IA/39/AP9/gQD/goMA/4OBAP+ChAD/gH4A/4KCAP+DfQD/fn0A/4B/AP9/ewD/goMA/4SCAP+AfgD/goEA/4ODAP+DhgD/hYUA/4aFAP+GewD/hogA/4d/AP+HfwD/iHwA/4WEAP+IfwD/iIMA/4eAAP+IggD/iIIA/4Z+AP+GgwD/hYIA/4GEAP+DgAD/hX8A/4GKAP+DgAD/hYIA/4N+AP+GgQD/hH0A/4OBAP+CgAD/goIA/4J+AP+CfgD/goIA/4KAAP+DgQD/hH0A/4aBAP+DfgD/hYIA/4OAAP+BigD/hX8A/4OAAP+BhAD/hYIA/4aDAP+GfgD/iIIA/4iCAP+HgAD/iIMA/4h/AP+FhAD/iHwA/4d/AP+HfwD/hogA/4Z7AP+GhQD/hYUA/4OGAP+DgwD/goEA/4B+AP+EggD/goMA/397AP+AfwD/fn0A/4N9AP+CggD/gH4A/4KEAP+DgQD/goMA/3+BAP9/fwD/f4IA/4CDAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/f4MA/39/AP9+ggD/f38A/3+BAP+AgwD/gIIA/4B/AP+BfQD/goEA/35/AP9/gwD/f30A/4OBAP+ChQD/gYUA/4CBAP+DhAD/goIA/4J/AP+FgwD/hoIA/4SBAP+FfgD/h4MA/4eEAP+FggD/hX0A/4t/AP+LhAD/iIAA/4eCAP+GhAD/hIIA/4SAAP+FgQD/g4MA/4J9AP+CegD/hYIA/4Z8AP+GhwD/hoAA/4SDAP+DggD/gYQA/4N/AP+BfQD/gX0A/4N/AP+BhAD/g4IA/4SDAP+GgAD/hocA/4Z8AP+FggD/gnoA/4J9AP+DgwD/hYEA/4SAAP+EggD/hoQA/4eCAP+IgAD/i4QA/4t/AP+FfQD/hYIA/4eEAP+HgwD/hX4A/4SBAP+GggD/hYMA/4J/AP+CggD/g4QA/4CBAP+BhQD/goUA/4OBAP9/fQD/f4MA/35/AP+CgQD/gX0A/4B/AP+AggD/gIMA/3+BAP9/fwD/foIA/39/AP9/gwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/36BAP+AhAD/fn4A/39/AP9+fwD/gYIA/4CCAP+AgAD/gH4A/4B9AP+AfwD/fn0A/4CAAP+AhQD/gX8A/39+AP+AgwD/g38A/4R/AP+DgAD/hIAA/4l/AP+DgAD/gogA/4eEAP+HfwD/hYAA/4h8AP+KgAD/iH8A/4aFAP+FfwD/hoAA/4aBAP+FfgD/h4AA/4SAAP+EggD/hX0A/4R+AP+HgAD/hYcA/4KBAP+CfQD/hIIA/4WHAP+DfwD/gnwA/4J8AP+DfwD/hYcA/4SCAP+CfQD/goEA/4WHAP+HgAD/hH4A/4V9AP+EggD/hIAA/4eAAP+FfgD/hoEA/4aAAP+FfwD/hoUA/4h/AP+KgAD/iHwA/4WAAP+HfwD/h4QA/4KIAP+DgAD/iX8A/4SAAP+DgAD/hH8A/4N/AP+AgwD/f34A/4F/AP+AhQD/gIAA/359AP+AfwD/gH0A/4B+AP+AgAD/gIIA/4GCAP9+fwD/f38A/35+AP+AhAD/foEA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP9+fQD/foIA/3+DAP9+fwD/gH4A/4CAAP+AgAD/gIAA/4B+AP+AfgD/gH0A/399AP+BgAD/gH4A/4KAAP+BfAD/gYAA/4F+AP+BhAD/gX0A/4GAAP+DgAD/gYIA/4B7AP+CfQD/iIIA/4R7AP+GfgD/hoAA/4V9AP+GgAD/hX8A/4R8AP+FfwD/iH0A/4iDAP+HggD/hn0A/4WFAP+HgQD/h4AA/4WAAP+ChgD/gX8A/4J/AP+DggD/g38A/4SAAP+EgAD/g38A/4OCAP+CfwD/gX8A/4KGAP+FgAD/h4AA/4eBAP+FhQD/hn0A/4eCAP+IgwD/iH0A/4V/AP+EfAD/hX8A/4aAAP+FfQD/hoAA/4Z+AP+EewD/iIIA/4J9AP+AewD/gYIA/4OAAP+BgAD/gX0A/4GEAP+BfgD/gYAA/4F8AP+CgAD/gH4A/4GAAP9/fQD/gH0A/4B+AP+AfgD/gIAA/4CAAP+AgAD/gH4A/35/AP9/gwD/foIA/359AP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIIA/4GCAP+AfgD/gYIA/39+AP+AfwD/gYEA/4B+AP+CfwD/gX4A/4F/AP+CgAD/gn8A/4WEAP+FdwD/g4IA/4aEAP+GhgD/hoIA/4aCAP+HgwD/hYIA/4N+AP+FhAD/hYEA/4h/AP+GgAD/h38A/4R6AP+GgQD/g4IA/4OCAP+EewD/goAA/4J/AP+BfAD/gX4A/4OBAP+EhwD/hIcA/4OBAP+BfgD/gXwA/4J/AP+CgAD/hHsA/4OCAP+DggD/hoEA/4R6AP+HfwD/hoAA/4h/AP+FgQD/hYQA/4N+AP+FggD/h4MA/4aCAP+GggD/hoYA/4aEAP+DggD/hXcA/4WEAP+CfwD/goAA/4F/AP+BfgD/gn8A/4B+AP+BgQD/gH8A/39+AP+BggD/gH4A/4GCAP+AggD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4KBAP+BggD/f3wA/4GEAP9/ggD/f4AA/4B9AP+CfgD/gYIA/4KDAP+BfgD/gYIA/39+AP+AfgD/g4UA/4GCAP+BgAD/g4EA/4SAAP+FfQD/h4MA/4WHAP+GfgD/hIIA/4SBAP+FfQD/hYIA/4aCAP+FfQD/hYEA/4J9AP+BggD/gn4A/4GCAP+CfAD/gYIA/4J9AP+AgQD/fn0A/359AP+AgQD/gn0A/4GCAP+CfAD/gYIA/4J+AP+BggD/gn0A/4WBAP+FfQD/hoIA/4WCAP+FfQD/hIEA/4SCAP+GfgD/hYcA/4eDAP+FfQD/hIAA/4OBAP+BgAD/gYIA/4OFAP+AfgD/f34A/4GCAP+BfgD/goMA/4GCAP+CfgD/gH0A/3+AAP9/ggD/gYQA/398AP+BggD/goEA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+BgwD/gH8A/4CAAP99ggD/f34A/3yBAP9/gAD/f4AA/4B/AP+AgQD/gn8A/3+AAP+AgQD/gX4A/3+BAP9+gQD/gX0A/4V7AP+EggD/hX8A/4V/AP+EggD/hYMA/4GBAP+EhAD/hIIA/4OBAP+EggD/g4AA/4F9AP+BfQD/fn0A/35+AP+AfgD/gH4A/4B6AP+BgAD/gYEA/3t7AP97ewD/gYEA/4GAAP+AegD/gH4A/4B+AP9+fgD/fn0A/4F9AP+BfQD/g4AA/4SCAP+DgQD/hIIA/4SEAP+BgQD/hYMA/4SCAP+FfwD/hX8A/4SCAP+FewD/gX0A/36BAP9/gQD/gX4A/4CBAP9/gAD/gn8A/4CBAP+AfwD/f4AA/3+AAP98gQD/f34A/32CAP+AgAD/gH8A/4GDAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/foEA/39+AP9/gAD/fYEA/3yAAP99gAD/foIA/4CEAP+AfgD/gIAA/4GAAP9/gQD/gXwA/4F/AP+AfgD/gH8A/4KBAP+FhAD/hH8A/4V/AP+DfAD/g38A/4CCAP+AgAD/f34A/35+AP9/fQD/gXwA/3+AAP+AfQD/f30A/3x5AP98fAD/e3wA/3h6AP96ggD/engA/3WBAP92fgD/dn4A/3WBAP96eAD/eoIA/3h6AP97fAD/fHwA/3x5AP9/fQD/gH0A/3+AAP+BfAD/f30A/35+AP9/fgD/gIAA/4CCAP+DfwD/g3wA/4V/AP+EfwD/hYQA/4KBAP+AfwD/gH4A/4F/AP+BfAD/f4EA/4GAAP+AgAD/gH4A/4CEAP9+ggD/fYAA/3yAAP99gQD/f4AA/39+AP9+gQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/359AP9+gAD/f4IA/4B+AP98fAD/fX0A/399AP9+fQD/gX4A/4CAAP9/fgD/gH0A/4F/AP+FfwD/g4IA/4N+AP+DgAD/g38A/4J+AP+CfQD/gX8A/4KAAP+AfAD/gHsA/3x9AP9/ewD/e3wA/3x+AP97fgD/e4EA/3x+AP95gAD/en4A/3t+AP94fgD/dYEA/3iDAP91fgD/d4AA/3eAAP91fgD/eIMA/3WBAP94fgD/e34A/3p+AP95gAD/fH4A/3uBAP97fgD/fH4A/3t8AP9/ewD/fH0A/4B7AP+AfAD/goAA/4F/AP+CfQD/gn4A/4N/AP+DgAD/g34A/4OCAP+FfwD/gX8A/4B9AP9/fgD/gIAA/4F+AP9+fQD/f30A/319AP98fAD/gH4A/3+CAP9+gAD/fn0A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gH8A/359AP9+gQD/foMA/3+DAP+BgwD/fX4A/36EAP+AggD/fX8A/4GCAP+CggD/hIAA/4OCAP+DggD/goAA/4KAAP+BfwD/gX4A/39/AP99fgD/foMA/318AP99ewD/fXsA/3p8AP94fQD/eoEA/3l/AP95fwD/eoIA/3uDAP95gwD/d4MA/3eGAP90gQD/eH8A/3iEAP94hAD/eH8A/3SBAP93hgD/d4MA/3mDAP97gwD/eoIA/3l/AP95fwD/eoEA/3h9AP96fAD/fXsA/317AP99fAD/foMA/31+AP9/fwD/gX4A/4F/AP+CgAD/goAA/4OCAP+DggD/hIAA/4KCAP+BggD/fX8A/4CCAP9+hAD/fX4A/4GDAP9/gwD/foMA/36BAP9+fQD/gH8A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/f30A/35+AP98ggD/fYIA/36BAP9+fgD/f4AA/3+AAP+BfgD/goQA/4OBAP+BfgD/goAA/4KCAP9/fgD/gYAA/35/AP98fwD/e30A/3x8AP96fwD/e4EA/3uDAP95ggD/eoUA/3qCAP96egD/eoAA/3yEAP97hAD/eYIA/3iDAP94hAD/doYA/3iGAP92hAD/doQA/3iGAP92hgD/eIQA/3iDAP95ggD/e4QA/3yEAP96gAD/enoA/3qCAP96hQD/eYIA/3uDAP97gQD/en8A/3x8AP97fQD/fH8A/35/AP+BgAD/f34A/4KCAP+CgAD/gX4A/4OBAP+ChAD/gX4A/3+AAP9/gAD/fn4A/36BAP99ggD/fIIA/35+AP9/fQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AfwD/fn4A/319AP99gAD/gYQA/4J9AP9/fAD/gX8A/3+BAP9+fwD/gIQA/4B9AP9/gQD/fn4A/32BAP96gwD/fH8A/31/AP98ggD/fIUA/3yCAP9/gwD/foEA/4CEAP98hgD/fYsA/3yJAP9/hAD/fYQA/3mDAP93gAD/eYAA/3mBAP94fgD/eYMA/3mDAP94fgD/eYEA/3mAAP93gAD/eYMA/32EAP9/hAD/fIkA/32LAP98hgD/gIQA/36BAP9/gwD/fIIA/3yFAP98ggD/fX8A/3x/AP96gwD/fYEA/35+AP9/gQD/gH0A/4CEAP9+fwD/f4EA/4F/AP9/fAD/gn0A/4GEAP99gAD/fX0A/35+AP+AfwD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gH8A/359AP+BfwD/gYAA/4B+AP9/fwD/gYEA/4GEAP+BgQD/gYIA/36AAP+AgwD/e4EA/35/AP9+gwD/f4QA/4KDAP9+gwD/gIQA/4KDAP99gQD/eH0A/3yCAP98fwD/fIIA/3uCAP94gQD/eoUA/3l/AP94fwD/eoAA/3iCAP94ggD/eoAA/3h/AP95fwD/eoUA/3iBAP97ggD/fIIA/3x/AP98ggD/eH0A/32BAP+CgwD/gIQA/36DAP+CgwD/f4QA/36DAP9+fwD/e4EA/4CDAP9+gAD/gYIA/4GBAP+BhAD/gYEA/39/AP+AfgD/gYAA/4F/AP9+fQD/gH8A/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+BgQD/goAA/4B8AP9+hAD/gIQA/4KCAP+BggD/gYQA/4GAAP+CggD/gX8A/36BAP+AgAD/gYQA/4CEAP+DhQD/f4MA/3+CAP9+gAD/fX4A/3+AAP97fAD/eoIA/3qEAP96gAD/d4EA/3yCAP97hAD/eH8A/3eCAP92ggD/doIA/3eCAP94fwD/e4QA/3yCAP93gQD/eoAA/3qEAP96ggD/e3wA/3+AAP99fgD/foAA/3+CAP9/gwD/g4UA/4CEAP+BhAD/gIAA/36BAP+BfwD/goIA/4GAAP+BhAD/gYIA/4KCAP+AhAD/foQA/4B8AP+CgAD/gYEA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgQD/gYEA/4B+AP+BgAD/gH4A/399AP+BgwD/goMA/4CCAP9+gwD/f4IA/36CAP+AgwD/foAA/36AAP9/gAD/foQA/4GEAP+AgwD/foYA/3qCAP99iQD/fIAA/3x/AP9/gQD/enoA/3qFAP94fwD/d4IA/3eCAP94fwD/eoUA/3p6AP9/gQD/fH8A/3yAAP99iQD/eoIA/36GAP+AgwD/gYQA/36EAP9/gAD/foAA/36AAP+AgwD/foIA/3+CAP9+gwD/gIIA/4KDAP+BgwD/f30A/4B+AP+BgAD/gH4A/4GBAP+AgQD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/gIAA/4CAAP+AgAD/"
  });
  const MOTION_RATE = 1.8;
  const MAX_CANVAS_DPR = 2; // performance-sensitive simplification for weak GPUs — unchanged from v1

  const VERTEX_SHADER = `
    attribute vec2 aPosition;
    varying vec2 vUv;

    void main() {
      vUv = (aPosition + 1.0) * 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;

  // Verbatim from the recovered engine.
  const WATER_SHADER = `
    precision highp float;

    const float ENCODED_ZERO = 0.5019607843;

    uniform sampler2D uPreviousWater;
    uniform vec2 uWaterTexel;
    uniform float uAspect;
    uniform float uPropagation;
    uniform float uDamping;
    uniform vec2 uImpulse;
    uniform float uImpulseRadius;
    uniform float uImpulseStrength;

    varying vec2 vUv;

    float decodeHeight(vec4 state) {
      return (state.r - ENCODED_ZERO) * 2.0;
    }

    float decodeVelocity(vec4 state) {
      return (state.g - ENCODED_ZERO) * 0.5;
    }

    void main() {
      vec4 centerState = texture2D(uPreviousWater, vUv);
      float center = decodeHeight(centerState);
      float left = decodeHeight(texture2D(uPreviousWater, vUv - vec2(uWaterTexel.x, 0.0)));
      float right = decodeHeight(texture2D(uPreviousWater, vUv + vec2(uWaterTexel.x, 0.0)));
      float down = decodeHeight(texture2D(uPreviousWater, vUv - vec2(0.0, uWaterTexel.y)));
      float up = decodeHeight(texture2D(uPreviousWater, vUv + vec2(0.0, uWaterTexel.y)));

      float neighborAverage = (left + right + down + up) * 0.25;
      float velocity = decodeVelocity(centerState);
      velocity += (neighborAverage - center) * uPropagation;
      velocity *= uDamping;

      vec2 isotropicDistance = (vUv - uImpulse) * vec2(uAspect, 1.0);
      float normalizedDistance = length(isotropicDistance) / max(uImpulseRadius, 0.0001);
      float impact = exp(-normalizedDistance * normalizedDistance * 3.2) * uImpulseStrength;

      velocity -= impact;
      float height = center + velocity - impact * 0.32;
      height = clamp(height, -0.94, 0.94);
      velocity = clamp(velocity, -0.245, 0.245);

      gl_FragColor = vec4(
        height * 0.5 + ENCODED_ZERO,
        velocity * 2.0 + ENCODED_ZERO,
        0.0,
        1.0
      );
    }
  `;

  // ambientWater() and the slope/gradient combination logic below are
  // verbatim from the recovered engine. Only the final texture-mapping
  // stage (frameUv -> uHome) is simplified, as noted above.
  const MATERIAL_SHADER = `
    precision highp float;

    const float ENCODED_ZERO = 0.5019607843;

    uniform sampler2D uHome;
    uniform sampler2D uWater;
    uniform vec2 uResolution;
    uniform vec2 uWaterTexel;
    uniform float uAmplitude;
    uniform float uScale;
    uniform float uViscosity;
    uniform float uTime;
    uniform float uLiquidMix;
    uniform vec2 uCoverScale;
    uniform vec2 uCoverOffset;
    // Crossing experiment additions (this pass). uGames is the second
    // "world" the same material can carry; uWorldMix (0 at rest, ramping
    // to 1 during the "revealing" phase, held at 1 once "revealed") drives
    // how much of it is currently showing. Both are read ONLY in the
    // blend at the very end of main() below — nothing about uHome's own
    // sampling, the refraction math above it, or any other uniform is
    // touched.
    uniform sampler2D uGames;
    uniform float uWorldMix;
    // Crossing v3 addition. The Stage A/Stage B+C boundary along the
    // uWorldMix ramp (STAGE_A_FORMATION_END on the JS side, same numeric
    // value, passed through as a uniform so the two can never drift
    // apart). Read only in the two blocks marked "Crossing v3 addition"
    // below — nothing above them (the water simulation read, the
    // ambient field, the base C400 refraction) is touched.
    uniform float uFormationEnd;

    // --- Games Arrival Experiment 01 addition ---
    // A single new multiplicative factor on the OPTICAL response only
    // (see where it is applied, below, at boundedSlope) — not on
    // canonical amplitude, not on liquidMix, not on totalSlope itself
    // (so it never touches localRichness/apertureField/spatialGate/
    // worldBlend, all of which are Crossing-owned and already fully
    // saturated to their T3 endpoint values by the time this can ever be
    // < 1 — Arrival never begins before materialPhase==="revealed", i.e.
    // never before uWorldMix has already reached and held at 1). Defaults
    // to 1.0 (a pure no-op) for the ENTIRE approved Crossing sequence;
    // only Arrival-specific JS (added below, after T3) ever sets it below
    // 1.0. This is the ONLY new shader uniform this experiment adds.
    uniform float uArrivalOpticalMix;

    varying vec2 vUv;

    float waterHeight(vec2 uv) {
      return (texture2D(uWater, clamp(uv, 0.0, 1.0)).r - ENCODED_ZERO) * 2.0;
    }

    void ambientWater(
      vec2 position,
      float time,
      float scale,
      float viscosity,
      out float height,
      out vec2 slope,
      out float curvature
    ) {
      vec2 directionOne = vec2(1.0, 0.0);
      vec2 directionTwo = vec2(0.5, 0.8660254);
      vec2 directionThree = vec2(-0.7660444, 0.6427876);
      vec2 directionFour = vec2(0.1736482, -0.9848078);

      float detail = mix(1.0, 0.70, viscosity);
      float frequencyOne = 4.4 * scale;
      float frequencyTwo = 6.1 * scale;
      float frequencyThree = 8.3 * scale;
      float frequencyFour = 11.2 * scale;
      float phaseOne = dot(position, directionOne) * frequencyOne + time * 0.62 + 0.35;
      float phaseTwo = dot(position, directionTwo) * frequencyTwo - time * 0.47 + 1.90;
      float phaseThree = dot(position, directionThree) * frequencyThree + time * 0.36 + 3.25;
      float phaseFour = dot(position, directionFour) * frequencyFour - time * 0.28 + 5.10;
      float amplitudeOne = 0.018;
      float amplitudeTwo = 0.014;
      float amplitudeThree = 0.010 * detail;
      float amplitudeFour = 0.006 * detail;

      height = 0.0;
      slope = vec2(0.0);
      curvature = 0.0;

      height += sin(phaseOne) * amplitudeOne;
      height += sin(phaseTwo) * amplitudeTwo;
      height += sin(phaseThree) * amplitudeThree;
      height += sin(phaseFour) * amplitudeFour;

      slope += directionOne * cos(phaseOne) * frequencyOne * amplitudeOne;
      slope += directionTwo * cos(phaseTwo) * frequencyTwo * amplitudeTwo;
      slope += directionThree * cos(phaseThree) * frequencyThree * amplitudeThree;
      slope += directionFour * cos(phaseFour) * frequencyFour * amplitudeFour;

      curvature -= sin(phaseOne) * frequencyOne * frequencyOne * amplitudeOne;
      curvature -= sin(phaseTwo) * frequencyTwo * frequencyTwo * amplitudeTwo;
      curvature -= sin(phaseThree) * frequencyThree * frequencyThree * amplitudeThree;
      curvature -= sin(phaseFour) * frequencyFour * frequencyFour * amplitudeFour;
    }

    void main() {
      float aspect = uResolution.x / max(uResolution.y, 1.0);
      vec2 position = (vUv - 0.5) * vec2(aspect, 1.0);
      float ambientHeight;
      vec2 ambientSlope;
      float ambientCurvature;

      ambientWater(
        position,
        uTime,
        max(uScale, 0.01),
        uViscosity,
        ambientHeight,
        ambientSlope,
        ambientCurvature
      );

      float center = waterHeight(vUv);
      float left = waterHeight(vUv - vec2(uWaterTexel.x, 0.0));
      float right = waterHeight(vUv + vec2(uWaterTexel.x, 0.0));
      float down = waterHeight(vUv - vec2(0.0, uWaterTexel.y));
      float up = waterHeight(vUv + vec2(0.0, uWaterTexel.y));

      float smoothedImpact = (center * 4.0 + left + right + down + up) * 0.125;
      vec2 impactSlope = vec2(right - left, up - down) * 3.0;
      float totalHeight = ambientHeight + smoothedImpact * 0.72;
      vec2 totalSlope = ambientSlope * 0.88 + impactSlope;

      float liquid = clamp(uLiquidMix, 0.0, 1.0);
      // totalSlope itself (used above for nothing yet, and below for
      // localRichness) is NOT touched — only boundedSlope, i.e. only the
      // term that feeds the visible refraction, carries the Arrival
      // factor. See uArrivalOpticalMix's declaration comment for why this
      // is safe post-T3.
      vec2 boundedSlope = (totalSlope / (1.0 + length(totalSlope) * 1.35)) * uArrivalOpticalMix;
      vec2 refractionPixels = clamp(
        boundedSlope * 2.25,
        vec2(-1.0),
        vec2(1.0)
      ) * uAmplitude * liquid;

      // totalSlope is already computed above for refractionPixels — reused
      // here at zero extra cost as a per-pixel "local richness" field.
      // Where the water's own structure is locally steeper (a wave crest,
      // the leading edge of propagating motion), richness is high; where
      // it is locally flatter, richness is low. This makes the reveal
      // front follow the material's own physical structure instead of
      // being a flat, time-only function of uWorldMix alone — the design
      // goal being "the field acts, not a single timer," per
      // the-phenomenology-of-the-threshold.md's coherence/no-single-point-
      // dominates language. Unchanged from Crossing v1/v2 — this is the
      // "organic, material-driven reveal" property v3 is also required to
      // preserve, not replace. Moved earlier in main() (was computed after
      // frameUv in v1/v2) only so Stage A below can read it before the
      // refracted sampling coordinate is finalized — the formula itself is
      // byte-for-byte unchanged.
      float localRichness = clamp(length(totalSlope) * 6.0, 0.0, 1.0);

      // --- Crossing v3 addition: Stage A (FORMATION) ---
      // Produces the "an opening is forming" signal using ONLY C400's
      // existing physical vocabulary (refraction/slope/displacement,
      // already computed above as refractionPixels) — zero uGames
      // involvement of any kind, per instruction ("sample no color or
      // background information from uGames" during formation). No new
      // texture, no new pass, no new color: this is literally MORE of
      // the exact same slope-driven displacement C400 already does
      // everywhere, applied unevenly so one region visibly begins to
      // behave differently from the water around it.
      //
      // apertureProgress ramps 0->1 across Stage A's own share of the
      // uWorldMix ramp (see uFormationEnd) and then holds at 1.0 for the
      // remainder — the opening, once formed, does not re-close while
      // Stages B/C proceed. Computed BEFORE apertureField now (v3.2):
      // apertureField's own thresholds read it below.
      float apertureProgress = clamp(uWorldMix / max(uFormationEnd, 0.0001), 0.0, 1.0);
      // --- Crossing v3.2 correction ---
      // v3's apertureField used a FIXED threshold pair (0.45, 0.85) on
      // localRichness, so the qualifying region was already at its full
      // extent (~65% of the canvas at richness>=0.45) in the very first
      // rendered frame of FORMATION — diagnosed directly via
      // computeFieldStats() (see NOTE.txt "PART C"): fractionAboveLower
      // measured ~0.65 at apertureProgress=0 and ~0.65 at
      // apertureProgress=1, i.e. essentially flat across the whole
      // interval. There was no spatial event to see — only a uniform
      // intensity ramp over an already-fixed-shape region. That is why
      // FORMATION read as "nothing, then a burst": the ONE visible thing
      // (worldBlend engaging Games at Stage B/C) was the only genuine
      // event in the whole sequence.
      //
      // The fix makes the threshold itself a function of apertureProgress
      // instead of a constant. A histogram of the live richness field
      // (v32-richness-histogram-probe.js) showed the field has a natural,
      // already-most-turbulent "core": ~15% of the canvas remains above
      // richness>=0.90 even as the threshold is pushed toward 0.99 (a
      // plateau, not a single point — a genuine structural feature of
      // C400's own simulated turbulence, not an artifact of this probe).
      // At apertureProgress=0 the edges are set ABOVE that core (edge0
      // 0.90, edge1 1.05 — note edge1 exceeds richness's own 0..1 ceiling,
      // so even richness===1.0 falls short of full saturation: the seed
      // is present but deliberately faint, not a hard-edged shape). As
      // apertureProgress advances across FORMATION, both edges relax
      // LINEARLY (apertureProgress is already confirmed linear in real
      // time — see NOTE.txt PART B/C — so this does not reintroduce a
      // pacing problem) down to v3.1's original fixed pair (0.45, 0.85)
      // at apertureProgress=1. At apertureProgress=1 this formula is
      // therefore IDENTICAL to v3.1's static smoothstep(0.45, 0.85, ...)
      // — the final spatial condition converges exactly, as required.
      //
      // No shape is drawn: edge0/edge1 only change WHICH slice of the
      // existing, completely unmodified localRichness field currently
      // qualifies. The topology is still 100% the water simulation's own
      // structure — this reveals more of what is already latent in it as
      // FORMATION proceeds, rather than introducing a new object.
      float apertureEdge0 = mix(0.90, 0.45, apertureProgress);
      float apertureEdge1 = mix(1.05, 0.85, apertureProgress);
      float apertureField = smoothstep(apertureEdge0, apertureEdge1, localRichness);
      // A restrained tonal (darkening) consequence was deliberately NOT
      // added here — see NOTE.txt. Displacement intensification alone
      // was judged sufficient to communicate "opening," and adding any
      // darkening tied to this same region risked reproducing exactly
      // the failure the instruction names explicitly: "a gradual dark
      // portal" as a disguised repeat of the abrupt black one. Every
      // pixel's color in Stage A remains an unmodified sample of uHome —
      // only WHERE on uHome each pixel samples from is perturbed.
      //
      // --- Crossing v3.2 correction (magnitude calibration) ---
      // v3's fixed value (1.4, i.e. a 40% boost) was measured
      // (v31/v32 diagnostics) to peak at well under 1 physical pixel of
      // ADDITIONAL displacement on the EliteBook's 1x desktop viewport —
      // at or below the threshold of reliable conscious perception, even
      // before the v3.2 spatial fix above. Calibrated up from 1.4 to 2.0
      // (see NOTE.txt "PART C" for the exact checkpoint measurements
      // before/after, the 3.0 candidate that was tried and rejected for
      // reading excessive on iPhone's already-larger base amplitude, and
      // why 2.0 was judged the smallest shared value — no per-device
      // tuning — that makes the now-growing aperture region consciously
      // legible on both tested devices without violent distortion or
      // typography illegibility). Still a FORMATION-only, Crossing-
      // specific multiplier — canonical C400 amplitude/refraction/water
      // physics are untouched; this constant did not exist before
      // Crossing v3.
      const float APERTURE_BOOST = 2.0;
      vec2 apertureBoostPixels = refractionPixels * (APERTURE_BOOST - 1.0) * apertureField * apertureProgress;
      vec2 totalRefractionPixels = refractionPixels + apertureBoostPixels;

      vec2 refractedViewportUv = clamp(vUv + totalRefractionPixels / uResolution, 0.0, 1.0);

      // Single clean texture sample: cover-fit map straight to uHome, no
      // second padded-crop mapping stage (our textures carry no padding).
      // frameUv now carries the Stage A aperture displacement too (when
      // apertureProgress/apertureField are nonzero) — both uHome and
      // uGames below are sampled through the SAME coordinate, so once
      // Games content does appear (Stage B/C), it is seen through the
      // same lensing the opening was already established with, not
      // through an independent, undistorted mapping.
      vec2 frameUv = uCoverOffset + refractedViewportUv * uCoverScale;
      vec4 homeColor = texture2D(uHome, frameUv);

      // --- Crossing experiment addition (v1) ---
      // gamesColor is sampled at the exact SAME refracted frameUv as
      // homeColor — both "worlds" are read through the identical liquid
      // distortion, so neither can ever read as an undistorted rectangle
      // laid over the other, and there is no second, independently-mapped
      // surface. This is the one new texture sample this experiment adds
      // relative to the locked C400 shader (see NOTE.txt for the count).
      // Sampling it unconditionally here costs nothing extra — its
      // CONTRIBUTION to gl_FragColor is what Stage A's hard gate below
      // holds at exactly zero, not the sample itself.
      vec4 gamesColor = texture2D(uGames, frameUv);

      // --- Crossing v2 correction (this pass) ---
      // v1's defect, diagnosed on the real-device footage: gamesColor is
      // sampled from a screenshot of the real Game Localization page,
      // which is ~98% near-black background and only ~2% bright text
      // (measured directly on the baked texture — see NOTE.txt). v1's
      // single richness-driven threshold treated every gamesColor pixel
      // identically regardless of what it depicted, so wherever the water
      // was locally rich, BOTH the (rare) text pixels and the (dominant)
      // black-background pixels reached worldBlend=1 at the same uWorldMix
      // — and because background pixels vastly outnumber text pixels,
      // what the eye actually registered first was "black spreading
      // across the liquid," not "text becoming legible." That read as a
      // different, oily substance arriving on top of C400, not C400
      // itself becoming able to show Games.
      //
      // The fix reuses the gamesColor sample already taken above — no new
      // texture, no new pass — and derives its own luminance from it, a
      // legitimate read of what is already there (the Games screenshot is
      // essentially binary: near-black fill, near-white glyphs), then
      // lets that luminance shift the SAME per-pixel threshold "tau"
      // independently of localRichness: bright (content) pixels get a
      // markedly LOWER threshold (they reveal early, while the surface is
      // still overwhelmingly C400-colored elsewhere), near-black
      // (background) pixels get a markedly HIGHER threshold (their own
      // chromatic takeover is deferred). This is the "smallest
      // architectural correction" the instruction asked for: the existing
      // richness-driven spatial organicness is untouched (still governs
      // WHERE within each category the reveal happens first); only WHAT
      // is prioritized within that structure — content before background
      // chroma — is new. Nothing is drawn that was not already going to
      // be drawn; only its ordering across uWorldMix changes.
      float gamesLuminance = dot(gamesColor.rgb, vec3(0.299, 0.587, 0.114));
      float baseTau = mix(0.55, 0.15, localRichness);
      // --- Crossing v3.4 correction (instruction sections 4/7) ---
      // v2's contentShift range (+0.30 background / -0.35 text, a 0.65
      // tau-unit spread) is what let text become visible while background
      // was still measured at exactly 0.0% contribution — diagnosed this
      // pass (v34-t0t3-dense-diagnosis.js, run against the unmodified
      // v3.3 build): first non-zero text at T0+296ms, first non-zero
      // background at T0+737-787ms, a ~440-495ms gap on both devices. The
      // instruction is explicit that the old rule is no longer compatible
      // with the current portal architecture, but also explicit not to
      // simply invert it into black-first (section 7) — text and
      // background should become eligible as COORDINATED information
      // belonging to the same discovered world, with at most a slightly
      // different progression, not a half-second head start for one over
      // the other. First attempt narrowed the spread to 0.65->0.20
      // (+0.10/-0.10) on the theory that contentShift alone was the
      // asymmetry; re-measuring THAT build (v34-contentshift-tuning-probe.js)
      // showed the gap barely moved (still ~400-550ms) — because most of
      // the apparent "spread" was never contentShift at all: baseTau's own
      // richness term already spans 0.40 tau-units (0.15..0.55) on its own,
      // dwarfing a +-0.10 contentShift. Since richness is a SPATIAL field
      // (from the water's own slope, sampled at each pixel's screen
      // location — see baseTau above) sampled identically regardless of
      // whether that location happens to show text or background, it does
      // not itself impose a text-vs-background bias; contentShift is the
      // ONLY term that does, so it is the only lever available without
      // touching the frozen richness/organicness mechanism. Narrowed
      // further to 0.65->0.08 (+0.04 background / -0.04 text) and
      // re-measured (NOTE.txt Part C): first-nonzero gap closed to
      // ~85-130ms on both devices, and — more importantly, visible in the
      // dense per-frame trace, not just the two crossing instants — the
      // two curves rise together from roughly the same real-time window
      // onward rather than one sitting at exactly 0.0% while the other is
      // already substantial. Text keeps a small, deliberate head start
      // (matching "may have slightly different progression curves if
      // necessary") without the old dramatic gap. Combined with this
      // pass's new RECOGNITION hold (section 5), no rendered frame shows
      // text over a still-undarkened, non-opening region (validated
      // visually, item B in NOTE.txt Part E). Nothing else about the
      // content-priority mechanism changed: bright pixels still reveal
      // marginally before dark ones, richness-driven spatial organicness
      // (baseTau) is completely untouched.
      float contentShift = mix(0.04, -0.04, gamesLuminance);
      float tau = clamp(baseTau + contentShift, 0.15, 0.85);

      // --- Crossing v3 addition: FORMATION -> FIRST SIGHT causal gate ---
      // gamesTimeInput remaps uWorldMix's [uFormationEnd, 1] range to
      // [0, 1] and is EXACTLY 0 for every uWorldMix <= uFormationEnd — a
      // hard, construction-guaranteed zero (proved below), not an
      // approximation — so gamesColor cannot contribute to gl_FragColor
      // AT ALL while uWorldMix is within Stage A, for any pixel,
      // regardless of tau/localRichness/gamesLuminance. The frame where
      // uWorldMix first exceeds uFormationEnd is the exact FORMATION ->
      // FIRST SIGHT transition event referred to in NOTE.txt.
      float gamesTimeInput = clamp((uWorldMix - uFormationEnd) / max(1.0 - uFormationEnd, 0.0001), 0.0, 1.0);

      // --- Crossing v3 addition: spatial containment (Stage B/C) ---
      // v2's content-priority tau above already biases WHEN a pixel
      // reveals by what it depicts (text before background); this adds
      // WHERE: Games content must appear only inside the opening already
      // established in Stage A, never over surrounding Home — even for a
      // pixel whose brightness alone would otherwise let it through
      // early. apertureThreshold starts at 0.85, matching apertureField's
      // own upper edge above (only the tightest, already-visibly-forming
      // aperture core qualifies at the very start of Stage B), and slides
      // to -0.20 as gamesTimeInput -> 1, so by the end of the ramp every
      // pixel qualifies — required for the worldMix=1 boundary guarantee
      // below. This is the spatial expression of "the opening ...
      // progressively ... while it expands."
      float apertureThreshold = mix(0.85, -0.20, gamesTimeInput);
      float spatialGate = smoothstep(apertureThreshold - 0.15, apertureThreshold + 0.15, localRichness);

      float worldBlend = smoothstep(tau - 0.15, tau + 0.15, gamesTimeInput) * spatialGate;

      // Boundary guarantee, re-derived for v3 (same proof shape as v1/v2,
      // now composed over gamesTimeInput and spatialGate as well as tau):
      //
      // At uWorldMix=0: gamesTimeInput=0 exactly (clamped). tau is
      // clamped to [0.15, 0.85], so tau-0.15 >= 0.00 = gamesTimeInput —
      // smoothstep(edge0>=x, edge1, x) with x<=edge0 returns exactly 0,
      // for every possible tau. worldBlend=0*spatialGate=0 regardless of
      // spatialGate's own value. Also apertureProgress=0 at uWorldMix=0,
      // so totalRefractionPixels==refractionPixels exactly — frame zero
      // is pixel-identical to the unmodified C400 refraction, matching
      // validation item 1 (frame zero must match normal Home) by
      // construction, unchanged from v1/v2.
      //
      // At uWorldMix=1: gamesTimeInput=1 exactly (uFormationEnd<1). tau
      // <= 0.85, so tau+0.15 <= 1.00 = gamesTimeInput — smoothstep(edge0,
      // edge1<=x, x) with x>=edge1 returns exactly 1, for every possible
      // tau, so the first factor is 1. apertureThreshold at
      // gamesTimeInput=1 is -0.20, so spatialGate's low edge is -0.35 —
      // since localRichness is itself clamped to [0, 1], every pixel's
      // localRichness >= 0 >= -0.35+0.15... explicitly: edge1 =
      // apertureThreshold+0.15 = -0.05, and localRichness >= 0 >= -0.05,
      // so smoothstep returns exactly 1 for every pixel regardless of its
      // own richness value. worldBlend=1*1=1 for every pixel — pure
      // Games, matching the held endpoint by construction, unchanged from
      // v1/v2.
      gl_FragColor = mix(homeColor, gamesColor, worldBlend);
    }
  `;

  const TEXTURES = Object.freeze({
    desktop: Object.freeze({ file: "prebaked/mv-home-desktop.png" }),
    mobile: Object.freeze({ file: "prebaked/mv-home-iphone.png" })
  });

  // Crossing experiment addition (this pass). Captured read-only from the
  // real repo's game-localization/index.html (capture-games-texture.js),
  // at the exact same viewport/dpr per device class as the TEXTURES
  // captures above, so the existing updateCoverMapping() logic (derived
  // purely from manifestEntries[key].cssWidth/cssHeight vs the live
  // window aspect — independent of which texture object is bound) applies
  // unchanged to both TEXTURES and GAMES_TEXTURES. No new cover-fit logic
  // was written for Games.
  const GAMES_TEXTURES = Object.freeze({
    desktop: Object.freeze({ file: "prebaked/mv-games-desktop.png" }),
    mobile: Object.freeze({ file: "prebaked/mv-games-iphone.png" })
  });

  const canvas = document.getElementById("mv-canvas");
  const statusEl = document.getElementById("mv-status");
  const controlsEl = document.getElementById("mv-controls-diagnostics"); // crossing experiment addition — Hide controls target (Activate/Reset/Hide themselves stay always visible)
  const hideControlsBtn = document.getElementById("mv-hide-controls"); // crossing experiment addition
  const activateBtn = document.getElementById("mv-activate");
  const resetBtn = document.getElementById("mv-reset");
  // mv-fps and mv-amplitude-readout are not present in this real-device
  // A/B test page's HTML (folded into #mv-live-readout instead) — both
  // lookups are null-safe at every call site (updateFpsReadout below,
  // and updateAmplitudeReadout's existing `if (!amplitudeReadoutEl)
  // return;` guard from the diagnostics pass).
  const fpsEl = document.getElementById("mv-fps");
  const amplitudeReadoutEl = document.getElementById("mv-amplitude-readout");
  // Diagnostics-pass-only elements — absent from the locked v3 checkpoint's
  // HTML, so these are looked up defensively (copyDiagBtn may be null if
  // this script is ever pointed at an older index-material.html; the
  // listener below is only attached when it's present).
  const copyDiagBtn = document.getElementById("mv-copy-diag");
  const copyDiagStatusEl = document.getElementById("mv-copy-diag-status");
  const diagFallbackTextarea = document.getElementById("mv-diag-fallback");
  // Real-device-AB-test-artifact-only elements (this pass).
  // Not present in this page's HTML (Stage C2 removes the DISCARD/RETAIN
  // selector from the UI — DISCARD stays hardcoded/canonical per
  // instruction, simulationTimeMode's own logic in updateWater() is
  // completely untouched — see index-material.html's comment). Both
  // lookups return null; every use below is already null-guarded.
  const modeDiscardBtn = document.getElementById("mv-mode-discard");
  const modeRetainBtn = document.getElementById("mv-mode-retain");
  // Candidate C, Stage C2's own selector: ZERO | C400.
  const modeZeroBtn = document.getElementById("mv-mode-zero");
  const modeC400Btn = document.getElementById("mv-mode-c400");
  const liveReadoutEl = document.getElementById("mv-live-readout");
  const variantButtons = {
    A: document.getElementById("mv-variant-a"),
    B: document.getElementById("mv-variant-b"),
    C: document.getElementById("mv-variant-c")
  };

  let gl = null;
  let materialProgram = null;
  let waterProgram = null;
  let materialLoc = null;
  let waterLoc = null;
  let textureObjects = new Map();
  let gamesTextureObjects = new Map(); // crossing experiment addition — mirrors textureObjects, loaded from GAMES_TEXTURES
  // v3.3 diagnosis-only addition (Phase 6 of the FIRST SIGHT/TRANSFER
  // instruction): CPU-readable copies of the same Home/Games images
  // already loaded for the GPU textures above, captured via an offscreen
  // 2D canvas at load time. Purely additive — does not touch the WebGL
  // upload path (uploadTexture/gl.texImage2D) in any way, and is never
  // read by MATERIAL_SHADER. Exists only so computeFieldStats() can, on
  // the JS side, sample "what would the Games/Home texture actually show
  // at this frameUv" — the same question the shader answers on the GPU —
  // and cross-reference it against worldBlend to separate "Games text
  // contribution" from "Games background contribution" per pixel, which
  // gl.readPixels on the final composited canvas alone cannot distinguish
  // (a mixed pixel doesn't say whether the Games portion was text or fill).
  let homePixelCache = new Map(); // key -> { data: Uint8ClampedArray (RGBA, top-left-origin row order), width, height }
  let gamesPixelCache = new Map(); // same shape, from GAMES_TEXTURES

  // v3.3 diagnosis-only addition. Draws `image` to a scratch 2D canvas and
  // returns its raw RGBA pixel buffer in normal (top-left-origin) row
  // order — i.e. the OPPOSITE vertical order from the GPU texture, which
  // is uploaded with UNPACK_FLIP_Y_WEBGL=true (see uploadTexture above).
  // Callers that sample this buffer by a shader-space (u,v) must flip v
  // themselves (row = (1-v)*(height-1)) — done once, centrally, in
  // computeFieldStats()'s sampleTexelDiag() helper below, not here.
  function capturePixelDataDiag(image) {
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    const scratch = document.createElement("canvas");
    scratch.width = w;
    scratch.height = h;
    const ctx2d = scratch.getContext("2d", { willReadFrequently: true });
    ctx2d.drawImage(image, 0, 0, w, h);
    const imgData = ctx2d.getImageData(0, 0, w, h);
    return { data: imgData.data, width: w, height: h };
  }
  let manifestEntries = null; // set by build (inline) or fetched (dev)

  let activeTextureKey = "desktop";
  let coverMapping = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  let waterResources = null;
  let simulationAccumulator = 0;
  let pendingImpulse = null;

  // ==========================================================================
  // TEMPORAL-ROBUSTNESS EXPERIMENT (this pass only, isolated on top of the
  // read-only diagnostics from the previous pass). Everything in this block,
  // plus the small edits to update()/updateWater() further down, is the
  // ONLY behavioral change in this file relative to the validated v3
  // checkpoint plus its diagnostics layer. Nothing here touches amplitude,
  // variant A/4px, LIQUID_ENGAGE_DURATION, propagation, damping, grid
  // dimensions, impulse magnitude/position, ambientWater(), motion rate,
  // shaders, the refraction formula, texture sampling, or MAX_SIMULATION_
  // STEPS (still 4/frame, unchanged) — this changes ONLY how much real
  // elapsed time is allowed to accumulate toward the water simulation's
  // own step counter before being discarded, and how large that backlog
  // is allowed to grow before ITS excess is discarded.
  //
  // Two independent discard points were found in the validated code, not
  // one:
  //   (1) update()'s render-delta clamp: `Math.min(..., 0.05)`. This caps
  //       how much of a frame's TRUE elapsed wall-clock gap ever reaches
  //       motionTime/updateWater() at all. At sustained FPS below ~20
  //       (frame gap > 50ms), any real time beyond 50ms is silently
  //       thrown away every single frame, forever — this is the dominant
  //       discard mechanism at realistic slow-hardware frame rates, not
  //       the one named in the previous diagnostic report.
  //   (2) updateWater()'s own cap-then-clamp: when stepCount hits
  //       MAX_SIMULATION_STEPS(4) in one frame, any simulationAccumulator
  //       above 1 is discarded. Given the render-delta clamp above already
  //       limits any single frame's addition to at most 0.05*60=3 steps
  //       (simulationRate=60), and post-step leftover is always <1, the
  //       accumulator can in practice never reach 4 under sustained
  //       conditions — this branch is nearly dead code as originally
  //       written. It only matters once (1) is changed, below.
  //
  // Mode B ("retain") addresses BOTH: updateWater() is fed the TRUE,
  // uncapped per-frame elapsed time (a new `rawDelta`, computed in
  // update() from the same now/lastFrameTime pair the existing clamped
  // `delta` already uses — motionTime/ambientWater()/the engage ramp
  // keep using the original clamped `delta`, completely unchanged), and
  // the overflow ceiling is raised from 1 step to BACKLOG_CEILING_STEPS.
  // Mode A ("discard") is byte-for-byte the original validated behavior:
  // clamped delta in, clamp-to-1 on overflow. Mode A is the default —
  // with no experiment API call, this file behaves exactly like v3.
  // ==========================================================================

  // Backlog ceiling: 60 simulation steps = exactly 1 second of nominal
  // simulation time (simulationRate = DEFAULTS.speed*300 = 60 steps/sec).
  // Chosen, not guessed, from three tied-together facts:
  //   - It is long enough to fully absorb an ordinary hitch (a GC pause,
  //     a brief throttling dip, the activation-path stalls seen in the
  //     previous pass's sandbox measurements, which topped out around
  //     400-500ms) without permanently erasing that time from the
  //     water's simulated age — which is the actual failure this
  //     experiment targets.
  //   - It is directly sized against the EXISTING, unchanged per-frame
  //     drain rate (MAX_SIMULATION_STEPS=4/frame): a 60-step ceiling
  //     takes at most 60/4 = 15 frames to fully drain once rendering
  //     recovers to a rate that can sustain 4 steps/frame — a bounded,
  //     predictable, sub-second worst-case catch-up window (e.g. ~0.25s
  //     at 60fps), not an open-ended "spiral of death."
  //   - Beyond it, the ORIGINAL safety property is kept: excess above
  //     the ceiling is still discarded, exactly as v1-v3 always
  //     discarded excess above 1. Only the threshold moves, from a
  //     value so small it discarded almost every ordinary slow frame,
  //     to one sized for the pathological case (e.g. a backgrounded tab
  //     for many seconds) that a bounded backlog is specifically meant
  //     to guard against.
  const BACKLOG_CEILING_STEPS = 60;

  let simulationTimeMode = "discard"; // "discard" (A, original/validated, default) | "retain" (B, experimental)
  let diagDiscardedSimulationSteps = 0; // cumulative steps' worth of backlog thrown away, either mode
  let diagLastOverflowDiscard = 0; // most recent single discard amount, for inspection

  // Perceptual-strength selector state. Switching this ONLY changes what
  // value draw() feeds into the uAmplitude uniform on the next frame — it
  // never touches canvas size, GL resources, waterResources, liquidMix,
  // or materialPhase.
  let currentVariant = "A";
  let dprCapped = 1; // recomputed in resizeCanvas(); used to convert the
                      // CSS-pixel-equivalent variant value into the
                      // backing-store-pixel value the shader expects.

  let materialPhase = "solid"; // solid | engaging | liquid | revealing | revealed
  let phaseStartedAt = 0;
  let phaseStartingMix = 0;
  let liquidMix = 0;
  let motionTime = 0;
  let lastFrameTime = 0;
  let frameRequest = 0;

  // Crossing experiment additions (this pass). worldPhaseStartedAt is
  // re-anchored twice: once when materialPhase first reaches "liquid"
  // (starts the WORLD_HOLD_DURATION wait) and again when it advances to
  // "revealing" (starts the WORLD_REVEAL_DURATION ramp) — see
  // updateMaterialTransition() below. worldMix is the new uWorldMix
  // uniform's JS-side value: 0 throughout solid/engaging/liquid/hold,
  // ramping 0->1 during "revealing", pinned at 1 during "revealed".
  let worldPhaseStartedAt = 0;
  let worldMix = 0;

  // Crossing v3.1 addition (PART B). materialPhase itself still only has
  // its original five values (solid/engaging/liquid/revealing/revealed —
  // unchanged, so the existing sandbox harness's phase-string checks and
  // any other external reader of getPhase() keep working exactly as
  // before). revealSubStage is a NEW, purely internal subdivision of
  // "revealing" alone, tracking which of the two independently-clocked
  // segments described above is currently driving worldMix.
  // formationToTransferAt records the exact performance.now() timestamp
  // of the FORMATION -> FIRST SIGHT event (also re-anchors the transfer
  // segment's own clock) — this is the "concrete perceptual/
  // implementation boundary" section 3 of the instruction asks this pass
  // to define and report.
  let revealSubStage = "formation"; // v3.4: "formation" | "recognition" | "discovery" | "passage" — meaningful only while materialPhase === "revealing". Was "formation" | "transfer" through v3.3; "transfer" is now split into three named, independently-clocked segments (see RECOGNITION_DURATION/DISCOVERY_DURATION/PASSAGE_DURATION above).
  let formationToTransferAt = 0;

  // --- Games Arrival Experiment 01 additions ---
  // A state machine entirely separate from materialPhase/revealSubStage
  // above — it only ever starts OBSERVING once materialPhase has already
  // reached "revealed" (T3), and never changes materialPhase, worldMix,
  // liquidMix, or anything else the approved Crossing owns. This is the
  // ONLY place this experiment tracks its own state.
  //   "none"   — before T3 (or Arrival not yet reached this frame); the
  //              approved Crossing's own state machine is what's running.
  //   "active" — settling in progress; arrivalOpticalMix ramping 1 -> 0.
  //   "stable" — Arrival complete; arrivalOpticalMix pinned at exactly 0.
  let arrivalPhase = "none";
  let arrivalStartedAt = 0;
  let arrivalOpticalMix = 1; // the uArrivalOpticalMix uniform's JS-side value — 1.0 (no-op) until Arrival begins

  let lockedScrollY = 0;

  // --- fps readout (display only; not part of the render/lifecycle path) ---
  let fpsFrameCount = 0;
  let fpsWindowStart = 0;
  let lastFpsValue = null; // real-device-AB-test-artifact-only: last 500ms-window fps, for the combined live readout
  let lastFrameTimeMs = null; // real-device-AB-test-artifact-only: same window's average ms/frame

  // ==========================================================================
  // DIAGNOSTIC INSTRUMENTATION (this pass only). Everything below this
  // point, plus the small marked call-sites further down (activate(),
  // runWaterStep(), updateWater(), draw(), render(), bindControls(),
  // initialize()), is purely ADDITIVE and READ-ONLY with respect to the
  // validated material: it reads uniforms/state that already exist and
  // reads GPU texture contents back via gl.readPixels(), but never writes
  // a new value into any uniform, never changes DEFAULTS/LIQUID_ENGAGE_
  // DURATION/the shaders/the amplitude tables/the simulation's control
  // flow. No behavior visible to a user who never opens window.__mvDiag
  // changes at all. See the delivery report for the exact diff against
  // the locked v3 checkpoint.
  //
  // Field-stat methodology note (stated once here, applies to every
  // number computeFieldStats() returns): height/velocity come straight
  // from gl.readPixels() on the actual simulation texture the GPU just
  // computed — those are exact, not estimated. Slope/refraction are
  // recomputed on the CPU from that same readback using the IDENTICAL
  // formulas MATERIAL_SHADER uses (ambientWater() translated verbatim,
  // the same neighbor-difference impactSlope/smoothedImpact, the same
  // totalSlope/boundedSlope/refractionPixels combination) — but evaluated
  // once per water-grid texel (~256x150 desktop / ~118x256 mobile)
  // instead of once per screen fragment. The shader's own bilinear
  // texture filtering means a screen-space evaluation would sit slightly
  // above/below a native-grid evaluation at any single fragment, but the
  // formulas, inputs and relative trends (growth over time, ambient-vs-
  // impulse split) are exact matches to what the shader computes. This
  // approximation is stated once here rather than repeated on every
  // number below.
  // ==========================================================================

  const DIAG_MAX_LOG_ENTRIES = 4000;

  let diagActivationTimeline = [];
  let diagStepHistory = [];
  let diagRafGaps = []; // rolling raw gaps, most recent last
  let diagRafStalls = []; // gaps > DIAG_STALL_THRESHOLD_MS, with timestamps
  let diagLongTasks = [];
  let diagPointerdowns = [];
  let diagLastRafTime = null;
  let diagArmed = false; // true from activate() entry until reset()
  let diagCumulativeSteps = 0;
  let diagActivationSeq = 0; // increments each activate(), so repeated
                              // on-page tests don't mix timelines
  const DIAG_STALL_THRESHOLD_MS = 100;

  // One-shot flags for the activation-path timeline, each fires at most
  // once per activation (cleared by diagResetForNewActivation). These are
  // the only state this pass adds to the render/update/draw call sites
  // themselves — each site does nothing but check-and-mark, no control
  // flow, no timing, no value it produces is altered.
  let diagFirstRafMarked = false;
  let diagFirstSimUpdateMarked = false;
  let diagFirstDrawMarked = false;
  let diagFirstDeformationFrameMarked = false;

  function diagNow() {
    return performance.now();
  }

  function diagMark(label, extra) {
    if (!diagArmed) return;
    diagActivationTimeline.push(Object.assign(
      { label, t: diagNow(), seq: diagActivationSeq },
      extra || {}
    ));
  }

  function diagResetForNewActivation() {
    diagActivationSeq += 1;
    diagActivationTimeline = [];
    diagStepHistory = [];
    diagCumulativeSteps = 0;
    diagArmed = true;
    diagFirstRafMarked = false;
    diagFirstSimUpdateMarked = false;
    diagFirstDrawMarked = false;
    diagFirstDeformationFrameMarked = false;
    // Real-device-AB-test-artifact addition: zero the temporal-robustness
    // experiment's own cumulative counters at the start of EVERY
    // activation (this runs on every activate() call, before the phase
    // guard, regardless of whether it was reached via the Reset button
    // or otherwise) — so a Reset -> switch mode -> Activate cycle never
    // shows backlog/discard numbers left over from the PREVIOUS mode's
    // run. simulationAccumulator itself is separately zeroed by
    // clearWaterFramebuffers() inside reset() (unchanged, pre-existing
    // behavior) — this only covers the two diagnostic-only tally
    // variables that reset() itself never touched.
    diagDiscardedSimulationSteps = 0;
    diagLastOverflowDiscard = 0;
  }

  function diagPushCapped(arr, entry) {
    arr.push(entry);
    if (arr.length > DIAG_MAX_LOG_ENTRIES) arr.shift();
    return arr;
  }

  // ambientWater() translated verbatim from MATERIAL_SHADER (GLSL) above —
  // same directions/frequencies/phases/amplitudes, same output triple.
  // Read-only: evaluating this in JS does not affect the shader, which
  // keeps computing it independently on the GPU exactly as before.
  function diagAmbientWater(px, py, time, scale, viscosity) {
    const d1x = 1.0, d1y = 0.0;
    const d2x = 0.5, d2y = 0.8660254;
    const d3x = -0.7660444, d3y = 0.6427876;
    const d4x = 0.1736482, d4y = -0.9848078;

    const detail = 1.0 + (0.70 - 1.0) * viscosity; // mix(1.0, 0.70, viscosity)
    const f1 = 4.4 * scale, f2 = 6.1 * scale, f3 = 8.3 * scale, f4 = 11.2 * scale;
    const p1 = (px * d1x + py * d1y) * f1 + time * 0.62 + 0.35;
    const p2 = (px * d2x + py * d2y) * f2 - time * 0.47 + 1.90;
    const p3 = (px * d3x + py * d3y) * f3 + time * 0.36 + 3.25;
    const p4 = (px * d4x + py * d4y) * f4 - time * 0.28 + 5.10;
    const a1 = 0.018, a2 = 0.014, a3 = 0.010 * detail, a4 = 0.006 * detail;

    const height =
      Math.sin(p1) * a1 + Math.sin(p2) * a2 + Math.sin(p3) * a3 + Math.sin(p4) * a4;

    const slopeX =
      d1x * Math.cos(p1) * f1 * a1 + d2x * Math.cos(p2) * f2 * a2 +
      d3x * Math.cos(p3) * f3 * a3 + d4x * Math.cos(p4) * f4 * a4;
    const slopeY =
      d1y * Math.cos(p1) * f1 * a1 + d2y * Math.cos(p2) * f2 * a2 +
      d3y * Math.cos(p3) * f3 * a3 + d4y * Math.cos(p4) * f4 * a4;

    return { height, slopeX, slopeY };
  }

  function diagStatsOf(values) {
    const n = values.length;
    if (n === 0) return { mean: 0, rms: 0, max: 0, variance: 0 };
    let sum = 0, sumSq = 0, max = 0;
    for (let i = 0; i < n; i += 1) {
      const v = values[i];
      sum += v;
      sumSq += v * v;
      const av = Math.abs(v);
      if (av > max) max = av;
    }
    const mean = sum / n;
    const rms = Math.sqrt(sumSq / n);
    let varSum = 0;
    for (let i = 0; i < n; i += 1) {
      const dv = values[i] - mean;
      varSum += dv * dv;
    }
    return { mean, rms, max, variance: varSum / n };
  }

  // The core measurement: reads the ACTUAL current water texture back
  // from the GPU (gl.readPixels — a passive read of what the simulation
  // already computed) and recomputes, per texel, exactly what
  // MATERIAL_SHADER computes from it. Returns null with a `reason` if
  // something required isn't available yet (e.g. before WebGL init).
  function computeFieldStats() {
    if (!gl || !waterResources) return { available: false, reason: "gl/waterResources not ready" };

    const w = waterResources.width;
    const h = waterResources.height;
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, waterResources.framebuffers[waterResources.readIndex]);
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);

    const ENCODED_ZERO = 0.5019607843;
    const heightField = new Float32Array(w * h);
    const velocityField = new Float32Array(w * h);
    for (let i = 0; i < w * h; i += 1) {
      const r = pixels[i * 4] / 255;
      const g = pixels[i * 4 + 1] / 255;
      heightField[i] = (r - ENCODED_ZERO) * 2.0;
      velocityField[i] = (g - ENCODED_ZERO) * 0.5;
    }

    const idx = (x, y) => {
      const cx = Math.min(Math.max(x, 0), w - 1); // CLAMP_TO_EDGE, same as the texture sampler
      const cy = Math.min(Math.max(y, 0), h - 1);
      return cy * w + cx;
    };

    const aspect = canvas.width / Math.max(canvas.height, 1);
    const scale = DEFAULTS.scale;
    const viscosity = DEFAULTS.viscosity;
    const time = motionTime;
    const liquid = Math.min(Math.max(liquidMix, 0), 1);
    const amp = currentAmplitudeTable()[currentVariant] * dprCapped;

    const ambientSlopeMag = new Float32Array(w * h);
    const impactSlopeMag = new Float32Array(w * h);
    const totalSlopeMag = new Float32Array(w * h);
    const boundedSlopeMag = new Float32Array(w * h);
    const refractionMag = new Float32Array(w * h);
    // Games Arrival Experiment 01 diagnosis-only addition: mirrors
    // MATERIAL_SHADER's actual arrival-adjusted refraction exactly —
    // boundedSlope * uArrivalOpticalMix, THEN clamped/scaled into
    // refraction pixels — so checkpoint captures can read the real,
    // currently-in-effect optical displacement (not the pre-Arrival
    // boundedSlopeMagnitude/refractionMagnitudePx above, which
    // deliberately stay byte-identical mirrors of the ORIGINAL,
    // arrival-unaware formula so existing v3.4 evidence/report
    // comparisons remain valid). At arrivalOpticalMix===1 (the entire
    // approved Crossing) these two are identical.
    const arrivalRefractionMag = new Float32Array(w * h);
    const smoothedImpactArr = new Float32Array(w * h);
    // v3.2 diagnosis-only addition (section 3 of the v3.2 instruction):
    // mirrors MATERIAL_SHADER's localRichness / apertureField /
    // apertureProgress / aperture-boost-magnitude computation exactly,
    // so FORMATION's actual visible-effect driver can be measured
    // directly instead of inferred from rendered-pixel RMSE (which
    // dilutes a spatially-small effect across a mostly-static canvas).
    // Read-only: does not affect the shader or any simulation state.
    const localRichnessArr = new Float32Array(w * h);
    const apertureFieldArr = new Float32Array(w * h);
    const apertureBoostMagArr = new Float32Array(w * h);
    const formationEndNow = Math.max(STAGE_A_FORMATION_END, 0.0001);
    const apertureProgressNow = Math.min(Math.max(worldMix / formationEndNow, 0), 1);
    const APERTURE_BOOST_DIAG = 2.0; // must track MATERIAL_SHADER's APERTURE_BOOST exactly

    // v3.3 diagnosis-only addition (Phase 6: diagnose FIRST SIGHT/TRANSFER
    // before changing it). Mirrors MATERIAL_SHADER's Stage B/C block
    // byte-for-byte: gamesLuminance (sampled from the CPU-side Games
    // pixel cache at the SAME refracted frameUv the shader itself samples
    // — includes Stage A's own aperture-boosted displacement, since that
    // displacement is still in effect for the rest of the sequence once
    // apertureProgress saturates at 1), baseTau/contentShift/tau,
    // gamesTimeInput, apertureThreshold/spatialGate, worldBlend. This is
    // the only way to separate "Games TEXT contribution" from "Games
    // BACKGROUND contribution" — gl.readPixels on the final composited
    // canvas alone cannot tell a blended pixel's Games portion was text
    // vs. fill; this mirror knows because it re-samples the source Games
    // texture directly, not the composited result.
    const worldBlendArr = new Float32Array(w * h);
    const gamesLuminanceArr = new Float32Array(w * h);
    const gamesTimeInputNow = Math.min(Math.max((worldMix - formationEndNow) / Math.max(1 - formationEndNow, 0.0001), 0), 1);
    const homeCache = homePixelCache.get(activeTextureKey);
    const gamesCache = gamesPixelCache.get(activeTextureKey);
    const canDiagTransfer = !!(homeCache && gamesCache);
    // Nearest-neighbor sample of a capturePixelDataDiag() buffer at
    // shader-space (u,v). Row is flipped (1-v) to match
    // UNPACK_FLIP_Y_WEBGL=true, which is how the GPU texture this mirrors
    // was actually uploaded (see uploadTexture()/capturePixelDataDiag()).
    function sampleTexelDiag(cache, u, v) {
      const cx = Math.min(Math.max(Math.round(u * (cache.width - 1)), 0), cache.width - 1);
      const cy = Math.min(Math.max(Math.round((1 - v) * (cache.height - 1)), 0), cache.height - 1);
      const o = (cy * cache.width + cx) * 4;
      return { r: cache.data[o] / 255, g: cache.data[o + 1] / 255, b: cache.data[o + 2] / 255 };
    }

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        const center = heightField[i];
        const left = heightField[idx(x - 1, y)];
        const right = heightField[idx(x + 1, y)];
        const down = heightField[idx(x, y - 1)];
        const up = heightField[idx(x, y + 1)];

        const smoothedImpact = (center * 4.0 + left + right + down + up) * 0.125;
        const impactSlopeX = (right - left) * 3.0;
        const impactSlopeY = (up - down) * 3.0;

        // vUv for this texel, in the same 0..1 screen-space the shader
        // samples uWater in — see the methodology note above.
        const vUvX = (x + 0.5) / w;
        const vUvY = (y + 0.5) / h;
        const posX = (vUvX - 0.5) * aspect;
        const posY = (vUvY - 0.5) * 1.0;
        const ambient = diagAmbientWater(posX, posY, time, Math.max(scale, 0.01), viscosity);
        const ambientSlopeX = ambient.slopeX * 0.88;
        const ambientSlopeY = ambient.slopeY * 0.88;

        const totalSlopeX = ambientSlopeX + impactSlopeX;
        const totalSlopeY = ambientSlopeY + impactSlopeY;
        const totalLen = Math.sqrt(totalSlopeX * totalSlopeX + totalSlopeY * totalSlopeY);
        const denom = 1.0 + totalLen * 1.35;
        const boundedX = totalSlopeX / denom;
        const boundedY = totalSlopeY / denom;
        const boundedLen = Math.sqrt(boundedX * boundedX + boundedY * boundedY);

        const refrXRaw = Math.min(Math.max(boundedX * 2.25, -1), 1) * amp * liquid;
        const refrYRaw = Math.min(Math.max(boundedY * 2.25, -1), 1) * amp * liquid;
        const refrLen = Math.sqrt(refrXRaw * refrXRaw + refrYRaw * refrYRaw);

        smoothedImpactArr[i] = smoothedImpact;
        ambientSlopeMag[i] = Math.sqrt(ambientSlopeX * ambientSlopeX + ambientSlopeY * ambientSlopeY);
        impactSlopeMag[i] = Math.sqrt(impactSlopeX * impactSlopeX + impactSlopeY * impactSlopeY);
        totalSlopeMag[i] = totalLen;
        boundedSlopeMag[i] = boundedLen;
        refractionMag[i] = refrLen;

        // Games Arrival Experiment 01 diagnosis-only mirror — see
        // arrivalRefractionMag's declaration comment above.
        const arrivalBoundedX = boundedX * arrivalOpticalMix;
        const arrivalBoundedY = boundedY * arrivalOpticalMix;
        const arrivalRefrXRaw = Math.min(Math.max(arrivalBoundedX * 2.25, -1), 1) * amp * liquid;
        const arrivalRefrYRaw = Math.min(Math.max(arrivalBoundedY * 2.25, -1), 1) * amp * liquid;
        arrivalRefractionMag[i] = Math.sqrt(arrivalRefrXRaw * arrivalRefrXRaw + arrivalRefrYRaw * arrivalRefrYRaw);

        // v3.2 diagnosis-only mirror — updated to match the v3.2 shader
        // correction: localRichness = clamp(len(totalSlope)*6,0,1);
        // apertureEdge0/1 relax linearly from (0.90,1.05) at
        // apertureProgress=0 to (0.45,0.85) at apertureProgress=1;
        // apertureField = smoothstep(edge0,edge1,localRichness); boost
        // magnitude = refrLen * (BOOST-1) * apertureField * apertureProgress
        // — byte-for-byte mirror of MATERIAL_SHADER's current Stage A block.
        const richness = Math.min(Math.max(totalLen * 6.0, 0), 1);
        const apEdge0 = 0.90 + (0.45 - 0.90) * apertureProgressNow;
        const apEdge1 = 1.05 + (0.85 - 1.05) * apertureProgressNow;
        const smoothstepAperture = (() => {
          const t = Math.min(Math.max((richness - apEdge0) / (apEdge1 - apEdge0), 0), 1);
          return t * t * (3 - 2 * t);
        })();
        localRichnessArr[i] = richness;
        apertureFieldArr[i] = smoothstepAperture;
        apertureBoostMagArr[i] = refrLen * (APERTURE_BOOST_DIAG - 1.0) * smoothstepAperture * apertureProgressNow;

        // v3.3 diagnosis-only: Stage B/C mirror, byte-for-byte against
        // MATERIAL_SHADER — see the block comment above computeFieldStats'
        // worldBlendArr declaration for why this needs the CPU pixel cache.
        if (canDiagTransfer) {
          const totalRefrFactor = 1.0 + (APERTURE_BOOST_DIAG - 1.0) * smoothstepAperture * apertureProgressNow;
          const totalRefrX = refrXRaw * totalRefrFactor;
          const totalRefrY = refrYRaw * totalRefrFactor;
          const refractedU = Math.min(Math.max(vUvX + totalRefrX / canvas.width, 0), 1);
          const refractedV = Math.min(Math.max(vUvY + totalRefrY / canvas.height, 0), 1);
          const frameU = coverMapping.offsetX + refractedU * coverMapping.scaleX;
          const frameV = coverMapping.offsetY + refractedV * coverMapping.scaleY;
          const gamesTexel = sampleTexelDiag(gamesCache, frameU, frameV);
          const gamesLuminance = gamesTexel.r * 0.299 + gamesTexel.g * 0.587 + gamesTexel.b * 0.114;
          const baseTau = 0.55 + (0.15 - 0.55) * richness;
          // v3.4: narrowed to match MATERIAL_SHADER's own contentShift correction (+0.10/-0.10, was +0.30/-0.35)
          const contentShift = 0.04 + (-0.04 - 0.04) * gamesLuminance;
          const tau = Math.min(Math.max(baseTau + contentShift, 0.15), 0.85);
          const apertureThreshold = 0.85 + (-0.20 - 0.85) * gamesTimeInputNow;
          const spatialGateEdge0 = apertureThreshold - 0.15;
          const spatialGateEdge1 = apertureThreshold + 0.15;
          const spatialGateT = Math.min(Math.max((richness - spatialGateEdge0) / Math.max(spatialGateEdge1 - spatialGateEdge0, 0.0001), 0), 1);
          const spatialGate = spatialGateT * spatialGateT * (3 - 2 * spatialGateT);
          const worldBlendEdge0 = tau - 0.15;
          const worldBlendEdge1 = tau + 0.15;
          const worldBlendT = Math.min(Math.max((gamesTimeInputNow - worldBlendEdge0) / Math.max(worldBlendEdge1 - worldBlendEdge0, 0.0001), 0), 1);
          const worldBlendSmooth = worldBlendT * worldBlendT * (3 - 2 * worldBlendT);
          worldBlendArr[i] = worldBlendSmooth * spatialGate;
          gamesLuminanceArr[i] = gamesLuminance;
        }
      }
    }

    // v3.2 diagnosis-only: fraction of pixels whose localRichness clears
    // apertureField's lower edge (0.45, where the spatial mask starts
    // contributing at all) and upper edge (0.85, full contribution) —
    // answers "how much of the canvas is even eligible for the aperture
    // effect right now," independent of apertureProgress's time ramp.
    let pixelsAboveLowerEdge = 0;
    let pixelsAboveUpperEdge = 0;
    // v3.2 diagnosis-only: a small richness histogram, to calibrate a
    // progress-dependent aperture threshold's STARTING edges (need to
    // know what richness cutoff yields a genuinely small "seed" area,
    // not just confirm today's fixed 0.45/0.85 pair).
    const richnessHistThresholds = [0.45, 0.60, 0.70, 0.80, 0.85, 0.90, 0.93, 0.95, 0.97, 0.98, 0.99];
    const richnessHistCounts = new Array(richnessHistThresholds.length).fill(0);
    for (let i = 0; i < w * h; i += 1) {
      if (localRichnessArr[i] >= 0.45) pixelsAboveLowerEdge += 1;
      if (localRichnessArr[i] >= 0.85) pixelsAboveUpperEdge += 1;
      for (let ti = 0; ti < richnessHistThresholds.length; ti += 1) {
        if (localRichnessArr[i] >= richnessHistThresholds[ti]) richnessHistCounts[ti] += 1;
      }
    }
    const richnessHistogram = richnessHistThresholds.map((thresh, ti) => ({
      thresh,
      fraction: richnessHistCounts[ti] / (w * h)
    }));

    // v3.3 diagnosis-only: aggregate worldBlendArr/gamesLuminanceArr into
    // the Phase 6 quantities the instruction asks for. "Occupied" fractions
    // use a >0.5 dominance threshold (this pixel's rendered color is
    // majority-Games, not majority-Home) — a rendered-screen-area measure,
    // distinct from the *_ContributionMean quantities below (worldBlend's
    // raw average — a blend-weighted measure that also counts partial
    // contribution from partially-blended edge pixels).
    let sumWorldBlend = 0;
    let textOccupiedCount = 0; // worldBlend>0.5 AND this Games texel is bright (text/content)
    let backgroundOccupiedCount = 0; // worldBlend>0.5 AND this Games texel is near-black (fill)
    let sumTextWeighted = 0; // worldBlend * isText, unthresholded — content contribution
    let sumBackgroundWeighted = 0; // worldBlend * isBackground, unthresholded — fill contribution
    const TEXT_LUMINANCE_THRESHOLD = 0.5; // matches MATERIAL_SHADER's own comment: content is "near-white glyphs"
    const BACKGROUND_LUMINANCE_THRESHOLD = 0.15; // matches "near-black fill"
    if (canDiagTransfer) {
      for (let i = 0; i < w * h; i += 1) {
        const wb = worldBlendArr[i];
        sumWorldBlend += wb;
        const lum = gamesLuminanceArr[i];
        const isText = lum >= TEXT_LUMINANCE_THRESHOLD;
        const isBackground = lum <= BACKGROUND_LUMINANCE_THRESHOLD;
        if (isText) sumTextWeighted += wb;
        if (isBackground) sumBackgroundWeighted += wb;
        if (wb > 0.5) {
          if (isText) textOccupiedCount += 1;
          else if (isBackground) backgroundOccupiedCount += 1;
        }
      }
    }
    const transferDiag = canDiagTransfer
      ? {
          worldMix,
          gamesTimeInput: gamesTimeInputNow,
          homeContributionMean: 1 - sumWorldBlend / (w * h),
          gamesContributionMean: sumWorldBlend / (w * h),
          gamesTextContributionMean: sumTextWeighted / (w * h),
          gamesBackgroundContributionMean: sumBackgroundWeighted / (w * h),
          fractionScreenOccupiedByGamesText: textOccupiedCount / (w * h),
          fractionScreenOccupiedByGamesBackground: backgroundOccupiedCount / (w * h),
          worldBlend: diagStatsOf(worldBlendArr)
        }
      : { available: false, reason: "homePixelCache/gamesPixelCache not ready for activeTextureKey" };

    return {
      available: true,
      gridWidth: w,
      gridHeight: h,
      inputs: { motionTime: time, liquidMix: liquid, amplitude: amp, variant: currentVariant, deviceClass: activeTextureKey },
      height: diagStatsOf(heightField),
      velocity: diagStatsOf(velocityField),
      smoothedImpact: diagStatsOf(smoothedImpactArr),
      ambientSlopeMagnitude: diagStatsOf(ambientSlopeMag),
      impactSlopeMagnitude: diagStatsOf(impactSlopeMag),
      totalSlopeMagnitude: diagStatsOf(totalSlopeMag),
      boundedSlopeMagnitude: diagStatsOf(boundedSlopeMag),
      refractionMagnitudePx: diagStatsOf(refractionMag),
      // v3.2 diagnosis-only additions:
      formationDiag: {
        worldMix,
        formationEnd: formationEndNow,
        apertureProgress: apertureProgressNow,
        localRichness: diagStatsOf(localRichnessArr),
        apertureField: diagStatsOf(apertureFieldArr),
        apertureBoostMagnitudePx: diagStatsOf(apertureBoostMagArr),
        fractionPixelsAboveLowerEdge: pixelsAboveLowerEdge / (w * h),
        fractionPixelsAboveUpperEdge: pixelsAboveUpperEdge / (w * h),
        richnessHistogram
      },
      // v3.3 diagnosis-only addition:
      transferDiag,
      cumulativeSimulationSteps: diagCumulativeSteps,
      simulationAccumulator,
      // Games Arrival Experiment 01 diagnosis-only additions:
      arrivalDiag: {
        arrivalPhase,
        arrivalOpticalMix,
        arrivalElapsedMs: arrivalPhase === "none" ? 0 : diagNow() - arrivalStartedAt,
        arrivalDurationMs: ARRIVAL_DURATION,
        arrivalAdjustedRefractionMagnitudePx: diagStatsOf(arrivalRefractionMag)
      }
    };
  }

  // ==========================================================================
  // Candidate C, Stage C2 — reuses, verbatim, the same captureWaterState()/
  // loadWaterState() functions Stage C1 built and verified (see that
  // checkpoint's NOTE.txt for the full serialization audit: WATER_SHADER
  // encodes exactly R=height, G=velocity; B/A are constants; motionTime
  // never reaches runWaterStep(); readIndex is pure ping-pong bookkeeping).
  // Not re-derived here — copied function-for-function.
  function captureWaterState() {
    if (!gl || !waterResources) return { available: false, reason: "gl/waterResources not ready" };
    const w = waterResources.width;
    const h = waterResources.height;
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, waterResources.framebuffers[waterResources.readIndex]);
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    let binary = "";
    for (let i = 0; i < pixels.length; i += 1) binary += String.fromCharCode(pixels[i]);
    return {
      available: true,
      width: w,
      height: h,
      pixelsBase64: btoa(binary),
      readIndexAtCapture: waterResources.readIndex,
      pendingImpulseAtCapture: pendingImpulse,
      simulationAccumulatorAtCapture: simulationAccumulator,
      canvasAspectAtCapture: window.innerWidth / Math.max(window.innerHeight, 1)
    };
  }

  // Stage C2, Round 2 addition. Bilinear resample of an RGBA8 buffer from
  // (srcW,srcH) to (dstW,dstH). Root-cause fix for the Round-3 real-device
  // finding: createWaterResources() sizes the LIVE grid from the actual
  // window's aspect ratio, so it only ever equals the C1 snapshot's fixed
  // 256x150 when the viewport happens to be exactly the 1366x800 used to
  // capture it (true in every sandboxed Playwright run, false on
  // essentially every real device) — loadWaterState() was previously
  // refusing to load whenever the two sizes differed, silently leaving the
  // water flat with no visible material in either mode's C400 branch.
  //
  // Correctness note for the R/G channels specifically (the only channels
  // that carry state — B/A are the fixed 0.0/1.0 constants documented at
  // WATER_SHADER): the encoding is affine (encoded = physical*scale +
  // ENCODED_ZERO), and bilinear interpolation commutes with an affine map,
  // so interpolating the encoded bytes directly and decoding afterward
  // gives the identical result to decoding first and interpolating the
  // physical values. Interpolating the encoded bytes directly (as done
  // here) is therefore exact, not an approximation of the encoding step —
  // the only approximation this introduces is the resampling itself
  // (spatial blending of neighboring texels), which is unavoidable
  // whenever the source and destination grids are different sizes.
  //
  // When srcW===dstW && srcH===dstH (every sandboxed 1366x800 test, and
  // the identical case) this returns the input completely unchanged — no
  // interpolation math runs, so Stage C1's exact bit-identical result at
  // matched grid sizes is entirely preserved and unaffected by this
  // addition.
  function resampleWaterPixels(srcPixels, srcW, srcH, dstW, dstH) {
    if (srcW === dstW && srcH === dstH) return srcPixels;
    const dst = new Uint8Array(dstW * dstH * 4);
    for (let dy = 0; dy < dstH; dy += 1) {
      const sy = ((dy + 0.5) * srcH) / dstH - 0.5;
      const sy0 = Math.min(Math.max(Math.floor(sy), 0), srcH - 1);
      const sy1 = Math.min(sy0 + 1, srcH - 1);
      const fy = Math.min(Math.max(sy - sy0, 0), 1);
      for (let dx = 0; dx < dstW; dx += 1) {
        const sx = ((dx + 0.5) * srcW) / dstW - 0.5;
        const sx0 = Math.min(Math.max(Math.floor(sx), 0), srcW - 1);
        const sx1 = Math.min(sx0 + 1, srcW - 1);
        const fx = Math.min(Math.max(sx - sx0, 0), 1);
        const i00 = (sy0 * srcW + sx0) * 4;
        const i10 = (sy0 * srcW + sx1) * 4;
        const i01 = (sy1 * srcW + sx0) * 4;
        const i11 = (sy1 * srcW + sx1) * 4;
        const di = (dy * dstW + dx) * 4;
        for (let c = 0; c < 4; c += 1) {
          const top = srcPixels[i00 + c] * (1 - fx) + srcPixels[i10 + c] * fx;
          const bot = srcPixels[i01 + c] * (1 - fx) + srcPixels[i11 + c] * fx;
          dst[di + c] = Math.round(top * (1 - fy) + bot * fy);
        }
      }
    }
    return dst;
  }

  // Loads a captured RGBA8 buffer as the CURRENT water state. Stage C2,
  // Round 2: a grid-dimension mismatch no longer throws — the buffer is
  // bilinear-resampled (resampleWaterPixels(), above) to the live grid's
  // exact dimensions before upload, since the live grid is real-device-
  // dependent and will practically never equal the fixed-viewport-captured
  // snapshot's 256x150 outside the sandbox. Identical dimensions (the
  // sandboxed 1366x800 case) pass through with zero modification.
  // pendingImpulse is explicitly nulled — see Stage C1's NOTE.txt for why
  // this is required for equivalence, and Stage C2's own activate()/
  // reset() below for why it matters again here: C400 must never receive
  // a second, freshly-triggered impulse on top of the one already baked
  // into the snapshot.
  function loadWaterState(pixelsBase64, width, height) {
    if (!gl || !waterResources) throw new Error("gl/waterResources not ready");
    const binary = atob(pixelsBase64);
    const rawPixels = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) rawPixels[i] = binary.charCodeAt(i);

    const targetW = waterResources.width;
    const targetH = waterResources.height;
    const pixels = resampleWaterPixels(rawPixels, width, height, targetW, targetH);
    const resampled = targetW !== width || targetH !== height;

    const targetIndex = waterResources.readIndex;
    gl.bindTexture(gl.TEXTURE_2D, waterResources.textures[targetIndex]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, targetW, targetH, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    pendingImpulse = null;
    simulationAccumulator = 1;
    lastLoadInfo = {
      loadedIntoTextureIndex: targetIndex,
      resampled,
      sourceWidth: width,
      sourceHeight: height,
      loadedWidth: targetW,
      loadedHeight: targetH
    };
    return lastLoadInfo;
  }
  // Stage C2, Round 2 — set by loadWaterState() above, read by
  // window.__mvCandidateC2.getLastLoadInfo() below. Verification-only.
  let lastLoadInfo = null;

  // stageC2Mode: "zero" (A, canonical validated trajectory, default) |
  // "c400" (B, begins from the hash-locked Candidate C1 step-400
  // snapshot). Read only by activate()/reset() below and by the live
  // readout's text formatting — never by runWaterStep(), WATER_SHADER,
  // updateWater(), or any uniform. simulationTimeMode (DISCARD/RETAIN)
  // is untouched and stays hardcoded at its default "discard" — its
  // selector UI is intentionally not present on this page (see
  // index-material.html's comment), keeping this artifact's only active
  // variable to ZERO vs C400, per instruction.
  // Crossing experiment change (this pass): default flipped from "zero"
  // to "c400". Per instruction, "ZERO remains a historical/control
  // reference only" for this experiment — C400 is the sole material used.
  // The ZERO|C400 selector UI itself is removed from index-material.html
  // for this experiment (hardcoding this choice, not just defaulting it);
  // the underlying stageC2Mode variable and its zero/c400 branch logic
  // throughout activate()/reset() are otherwise untouched, so the
  // historical ZERO path stays fully intact and reachable via
  // window.__mvCandidateC2.setMode("zero") for reference/debugging.
  let stageC2Mode = "c400";

  // ==========================================================================
  // Crossing v3.1 addition — PART A: activation-hitch removal.
  //
  // Cause, verified directly in this source before writing anything below
  // (see NOTE.txt for the real-device confirmation this reproduces):
  // activate() and reset() both call loadWaterState() SYNCHRONOUSLY, on
  // the same tick as the click/tap handler. loadWaterState() does, in
  // order: atob() of a ~150KB base64 string; a JS charCodeAt loop over
  // every decoded byte (~150,000 iterations) to build a Uint8Array;
  // resampleWaterPixels() — a full bilinear resample over the destination
  // grid (nested loop, up to SIMULATION_LONG_SIDE x SIMULATION_MIN_SIDE x
  // 4 channels), which the code's own prior comment already documents as
  // running on "essentially every real device" (the live grid's aspect
  // almost never exactly matches the 256x150 snapshot's fixed aspect);
  // and a synchronous gl.texImage2D upload. All of this lands inside the
  // perceptually critical click -> first-response window.
  //
  // The fix changes WHEN this work happens, not WHAT it produces: the
  // exact same decode+resample function (computeC400PixelsForGrid, a
  // direct extraction of loadWaterState()'s own first three steps, not a
  // rewrite) is run once, off the critical path, during idle time after
  // the water simulation's real dimensions are first known (hooked into
  // resizeCanvas() below, which covers both initial load and any later
  // resize/orientation change) — and its result is cached. activate()/
  // reset() then call loadC400Snapshot() (defined below) instead of
  // loadWaterState() directly: if a valid cached buffer exists for the
  // CURRENT waterResources dimensions, only the cheap GPU upload happens
  // on the click; if not (prewarm still pending, or a resize invalidated
  // it since), loadC400Snapshot() falls back to calling the original,
  // completely UNTOUCHED loadWaterState() — so correctness is never
  // sacrificed for speed, only opportunistically sped up. loadWaterState()
  // itself is not modified in any way (it remains exactly v3's version,
  // still reachable unchanged via window.__mvCandidateC2.loadWaterState()
  // for the existing verification harness) — this addition sits entirely
  // alongside it.
  //
  // Nothing here begins visible liquefaction before Activate (the
  // prewarm only populates a plain JS Uint8Array in memory — it never
  // touches waterResources' GPU textures, materialPhase, liquidMix, or
  // anything rendered), and nothing here advances the simulation ahead
  // of schedule (simulationAccumulator/pendingImpulse are untouched by
  // the prewarm step itself; they are only set, exactly as before, at
  // the moment loadC400Snapshot()'s upload actually runs, inside
  // activate()/reset(), same as v3).
  // ==========================================================================

  let prewarmedC400 = null; // { pixels: Uint8Array, width, height } | null — valid only while width/height match waterResources' CURRENT dimensions
  let prewarmScheduled = false;
  let prewarmLog = []; // always-on (not gated by diagArmed, which only exists during an activation timeline) — verification-only visibility into prewarm lifecycle, independent of any activation ever happening.

  function prewarmLogPush(event, extra) {
    prewarmLog.push(Object.assign({ event, t: performance.now() }, extra || {}));
    if (prewarmLog.length > 20) prewarmLog.shift();
  }

  // Pure CPU computation — byte-for-byte the same three steps
  // loadWaterState() performs (atob decode, charCodeAt reconstruction
  // loop, resampleWaterPixels()), extracted so both the prewarm path and
  // the original synchronous function compute identically for the same
  // inputs. Touches no GPU state, no waterResources texture, no
  // simulation variable — returns a plain Uint8Array only.
  function computeC400PixelsForGrid(targetW, targetH) {
    const binary = atob(CANDIDATE_C1_SNAPSHOT_STEP400.pixelsBase64);
    const rawPixels = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) rawPixels[i] = binary.charCodeAt(i);
    return resampleWaterPixels(
      rawPixels,
      CANDIDATE_C1_SNAPSHOT_STEP400.width,
      CANDIDATE_C1_SNAPSHOT_STEP400.height,
      targetW,
      targetH
    );
  }

  // Schedules (or skips, if already valid/pending) computing the
  // prewarmed buffer for waterResources' CURRENT dimensions. Called from
  // resizeCanvas() below — never from activate()/reset() themselves, so
  // it can never itself be the thing running synchronously on a click.
  // Uses requestIdleCallback where available (Chrome/desktop) so the
  // computation is scheduled for genuinely idle time rather than
  // competing with page-load work; falls back to setTimeout(fn, 0) on
  // browsers without it (notably Safari/iOS at time of writing) — still
  // off the click path, just scheduled via the macrotask queue instead
  // of the idle-callback queue.
  function schedulePrewarmC400() {
    if (stageC2Mode !== "c400" || !waterResources) return;
    const targetW = waterResources.width;
    const targetH = waterResources.height;
    if (prewarmedC400 && prewarmedC400.width === targetW && prewarmedC400.height === targetH) {
      return; // already valid for the current grid
    }
    if (prewarmScheduled) return;
    prewarmScheduled = true;
    prewarmLogPush("scheduled", { targetW, targetH });
    const run = () => {
      prewarmScheduled = false;
      if (!waterResources) return;
      // Read dimensions fresh here, not the targetW/targetH captured at
      // schedule time — if another resize landed while this was
      // pending, this computes for the CURRENT grid, not a stale one.
      const w = waterResources.width;
      const h = waterResources.height;
      try {
        const pixels = computeC400PixelsForGrid(w, h);
        prewarmedC400 = { pixels, width: w, height: h };
        prewarmLogPush("ready", { width: w, height: h });
      } catch (e) {
        prewarmedC400 = null; // fail safe — loadC400Snapshot() falls back to the synchronous path
        prewarmLogPush("failed", { message: String((e && e.message) || e) });
      }
    };
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(run, { timeout: 1500 });
    } else {
      setTimeout(run, 0);
    }
  }

  // What activate()/reset() call instead of loadWaterState() directly.
  // Fast path: if the prewarmed buffer is valid for the CURRENT
  // waterResources dimensions, skip decode+resample entirely and only
  // do the upload (mirrors loadWaterState()'s own upload tail exactly —
  // same texImage2D call, same lastLoadInfo shape plus one extra
  // verification-only field). Fallback: identical to v3's original
  // behavior, byte-for-byte — calls the untouched loadWaterState().
  function loadC400Snapshot() {
    if (
      prewarmedC400 &&
      waterResources &&
      prewarmedC400.width === waterResources.width &&
      prewarmedC400.height === waterResources.height
    ) {
      const targetW = waterResources.width;
      const targetH = waterResources.height;
      const targetIndex = waterResources.readIndex;
      gl.bindTexture(gl.TEXTURE_2D, waterResources.textures[targetIndex]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, targetW, targetH, 0, gl.RGBA, gl.UNSIGNED_BYTE, prewarmedC400.pixels);
      pendingImpulse = null;
      simulationAccumulator = 1;
      lastLoadInfo = {
        loadedIntoTextureIndex: targetIndex,
        resampled: targetW !== CANDIDATE_C1_SNAPSHOT_STEP400.width || targetH !== CANDIDATE_C1_SNAPSHOT_STEP400.height,
        sourceWidth: CANDIDATE_C1_SNAPSHOT_STEP400.width,
        sourceHeight: CANDIDATE_C1_SNAPSHOT_STEP400.height,
        loadedWidth: targetW,
        loadedHeight: targetH,
        fromPrewarmCache: true // v3.1: decode+resample were skipped this call — see NOTE.txt validation #20
      };
      prewarmLogPush("usedCache", { width: targetW, height: targetH });
      return lastLoadInfo;
    }
    // Cache miss (prewarm still pending, failed, or a resize invalidated
    // it since it completed): fall back to v3's original, unmodified
    // synchronous path — never throws, never approximates.
    prewarmLogPush("cacheMiss", {
      hasCache: !!prewarmedC400,
      cacheDims: prewarmedC400 ? { w: prewarmedC400.width, h: prewarmedC400.height } : null,
      liveDims: waterResources ? { w: waterResources.width, h: waterResources.height } : null
    });
    const info = loadWaterState(
      CANDIDATE_C1_SNAPSHOT_STEP400.pixelsBase64,
      CANDIDATE_C1_SNAPSHOT_STEP400.width,
      CANDIDATE_C1_SNAPSHOT_STEP400.height
    );
    info.fromPrewarmCache = false;
    return info;
  }

  function diagGetSnapshot() {
    const simulationRate = DEFAULTS.speed * 300;
    return {
      capturedAt: diagNow(),
      phase: materialPhase,
      liquidMix,
      amplitudeInfo: {
        variant: currentVariant,
        deviceClass: activeTextureKey,
        cssPxTarget: currentAmplitudeTable()[currentVariant],
        dprCapped,
        shaderUAmplitude: currentAmplitudeTable()[currentVariant] * dprCapped
      },
      // Temporal-robustness-experiment fields (this pass only) — see the
      // block above simulationAccumulator's declaration for the full
      // rationale. simulationAgeSeconds is "how old, in simulated time,
      // the water is" — the quantity this experiment is trying to make
      // track wall-clock time regardless of rendering performance.
      temporalExperiment: {
        mode: simulationTimeMode,
        backlogCeilingSteps: simulationTimeMode === "retain" ? BACKLOG_CEILING_STEPS : 1,
        accumulatorBacklogSteps: simulationAccumulator,
        cumulativeSimulationSteps: diagCumulativeSteps,
        simulationAgeSeconds: diagCumulativeSteps / simulationRate,
        discardedSimulationStepsTotal: diagDiscardedSimulationSteps,
        lastOverflowDiscard: diagLastOverflowDiscard
      },
      fieldStats: computeFieldStats()
    };
  }
  // ==========================================================================

  function setStatus(state, text) {
    statusEl.dataset.state = state;
    statusEl.textContent = text;
  }

  function selectTextureKey() {
    return window.innerWidth <= 700 ? "mobile" : "desktop";
  }

  function updateCoverMapping() {
    const key = activeTextureKey;
    const entry = manifestEntries[key];
    const viewportAspect = window.innerWidth / Math.max(window.innerHeight, 1);
    const referenceAspect = entry.cssWidth / entry.cssHeight;
    let scaleX = 1;
    let scaleY = 1;

    if (viewportAspect > referenceAspect) {
      scaleY = referenceAspect / viewportAspect;
    } else {
      scaleX = viewportAspect / referenceAspect;
    }

    coverMapping = {
      scaleX,
      scaleY,
      offsetX: (1 - scaleX) * 0.5,
      offsetY: (1 - scaleY) * 0.5
    };
  }

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || "shader compile error";
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function createProgram(fragmentSource) {
    const vertexShader = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || "shader link error";
      gl.deleteProgram(program);
      throw new Error(message);
    }
    return program;
  }

  function createGeometry() {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
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

  function uploadTexture(image) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    return texture;
  }

  function deleteWaterResources() {
    if (!waterResources) return;
    for (const fb of waterResources.framebuffers) gl.deleteFramebuffer(fb);
    for (const tex of waterResources.textures) gl.deleteTexture(tex);
    waterResources = null;
  }

  function clearWaterFramebuffers() {
    if (!waterResources) return;
    gl.clearColor(128 / 255, 128 / 255, 0.0, 1.0);
    gl.viewport(0, 0, waterResources.width, waterResources.height);
    for (const fb of waterResources.framebuffers) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    waterResources.readIndex = 0;
    simulationAccumulator = 0;
    pendingImpulse = null;
  }

  function createWaterResources() {
    const aspect = window.innerWidth / Math.max(window.innerHeight, 1);
    const width = aspect >= 1
      ? SIMULATION_LONG_SIDE
      : Math.max(SIMULATION_MIN_SIDE, Math.round(SIMULATION_LONG_SIDE * aspect));
    const height = aspect >= 1
      ? Math.max(SIMULATION_MIN_SIDE, Math.round(SIMULATION_LONG_SIDE / aspect))
      : SIMULATION_LONG_SIDE;

    if (waterResources && waterResources.width === width && waterResources.height === height) {
      return;
    }

    deleteWaterResources();
    const textures = [];
    const framebuffers = [];

    for (let i = 0; i < 2; i += 1) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("cannot create water simulation surface");
      }
      textures.push(texture);
      framebuffers.push(framebuffer);
    }

    waterResources = { width, height, textures, framebuffers, readIndex: 0 };
    clearWaterFramebuffers();
  }

  function getViewportBox() {
    const vv = window.visualViewport;
    if (vv) {
      return { width: vv.width, height: vv.height };
    }
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function resizeCanvas() {
    const box = getViewportBox();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR);
    dprCapped = dpr; // stored so draw() can convert CSS-px variant amplitude -> backing-store px
    const width = Math.max(1, Math.round(box.width * dpr));
    const height = Math.max(1, Math.round(box.height * dpr));

    canvas.style.width = `${box.width}px`;
    canvas.style.height = `${box.height}px`;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const nextKey = selectTextureKey();
    if (nextKey !== activeTextureKey) {
      activeTextureKey = nextKey;
    }
    updateCoverMapping();
    if (gl) createWaterResources();
    // Crossing v3.1 addition: waterResources' dimensions are only ever
    // (re)established here (createWaterResources()'s sole call site), so
    // this is the single correct hook for keeping the activation-hitch
    // prewarm cache valid — covers both the initial call during
    // initialize() and every later resize/orientation change. Schedules
    // idle-time work only; never runs anything synchronously itself.
    schedulePrewarmC400();
    updateAmplitudeReadout(); // dprCapped may have changed (e.g. orientation
                               // change, window move to another display) —
                               // keep the on-screen effective-amplitude
                               // numbers live and accurate, never stale.
  }

  // Part 2 of this pass: make the active amplitude unambiguous on screen,
  // so a real-device recording is self-documenting. Read-only — this
  // function never writes to currentVariant, dprCapped, or any simulation
  // state; it only reflects them into the diagnostic strip.
  function updateAmplitudeReadout() {
    if (!amplitudeReadoutEl) return;
    const cssPx = currentAmplitudeTable()[currentVariant];
    const shaderAmp = cssPx * dprCapped;
    amplitudeReadoutEl.textContent =
      `variant: ${currentVariant} · ${activeTextureKey} · amp: ${cssPx}px css (${shaderAmp.toFixed(2)} shader, dpr ${dprCapped.toFixed(2)})`;
  }

  function easeMaterial(value) {
    const c = Math.min(Math.max(value, 0), 1);
    return c * c * (3 - 2 * c);
  }

  function mixNumber(a, b, t) {
    return a + (b - a) * t;
  }

  function triggerImpulse(point) {
    pendingImpulse = { x: point.x, y: point.y };
    simulationAccumulator = Math.max(simulationAccumulator, 1);
  }

  function activate() {
    // diagResetForNewActivation() arms diagArmed BEFORE the phase guard
    // below, so a mark exists even in the (currently impossible via UI,
    // since the button is disabled outside "solid") early-return case —
    // useful signal if that ever changes. This call, and the diagMark()
    // call immediately after it, are the only two statements this pass
    // adds ahead of the original first line of activate(); everything
    // from the phase guard onward is untouched and in its original order.
    diagResetForNewActivation();
    diagMark("activate:handlerEntry");

    if (materialPhase !== "solid") return;

    lockedScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.top = `-${lockedScrollY}px`;
    document.documentElement.classList.add("mv-scroll-locked");
    document.body.classList.add("mv-active");

    canvas.classList.add("is-visible", "mv-canvas--interactive");

    materialPhase = "engaging";
    phaseStartedAt = performance.now();
    diagMark("activate:phaseStart", { phaseStartedAt });
    phaseStartingMix = liquidMix;

    // Candidate C, Stage C2 — the ONLY behavioral branch point in this
    // whole file. ZERO (default): completely unmodified, byte-identical
    // to the validated original — triggers the single canonical impulse
    // that starts the whole liquefaction from a flat field, exactly as
    // it always has.
    //
    // C400: does NOT call triggerImpulse() here. The originating
    // impulse's effect is already baked into the loaded snapshot's
    // height/velocity field (Candidate C1 confirmed the snapshot already
    // reflects a state where that one-shot impulse has been consumed);
    // calling triggerImpulse() again here would inject a second,
    // non-equivalent disturbance C1 specifically identified as
    // incorrect. Instead, the exact snapshot is (re-)loaded at this
    // exact instant, guaranteeing the visible engage sequence always
    // starts from precisely the preserved step-400 state regardless of
    // how long the visitor dwelt in "solid" phase after Reset — see
    // NOTE.txt for why that dwell-time re-load is necessary (update()/
    // updateWater() run unconditionally every frame regardless of
    // materialPhase, so a loaded C400 field would otherwise keep quietly
    // evolving in real time between Reset and Activate). This is
    // logically separate from, and does not affect, the visitor's own
    // post-activation click/touch impulses below in bindControls() —
    // those remain fully enabled and unmodified in both modes.
    if (stageC2Mode === "c400") {
      // Crossing v3.1: loadC400Snapshot() (PART A, above) instead of
      // loadWaterState() directly — uses the prewarmed buffer when valid
      // (the common case), otherwise falls back to calling
      // loadWaterState() itself, unchanged. Same exact bytes end up
      // uploaded either way; only whether the decode+resample happened
      // synchronously on THIS click differs.
      loadC400Snapshot();
      diagCumulativeSteps = 400; // honest step-count bookkeeping: this
                                  // field already carries 400 steps of
                                  // history before this activation's own
                                  // real-time stepping accumulates on top.
    } else {
      triggerImpulse({ x: 0.5, y: 0.5 });
    }

    activateBtn.disabled = true;
    resetBtn.disabled = false;
    if (modeDiscardBtn) modeDiscardBtn.disabled = true;
    if (modeRetainBtn) modeRetainBtn.disabled = true;
    if (modeZeroBtn) modeZeroBtn.disabled = true;
    if (modeC400Btn) modeC400Btn.disabled = true;
    setStatus("preparing", "engaging");
  }

  function reset() {
    materialPhase = "solid";
    liquidMix = 0;
    motionTime = 0;
    // Crossing experiment additions (this pass): clear the new world-
    // reveal state alongside the pre-existing liquidMix/motionTime clear
    // above, so "Reset & Replay" reproduces clean initial conditions for
    // Games too, not just for the water material. Purely additive — the
    // three lines above this comment are byte-identical to the locked
    // C400 checkpoint.
    worldMix = 0;
    worldPhaseStartedAt = 0;
    // Crossing v3.1 addition: clear the new sub-stage tracking alongside
    // the pre-existing worldMix/worldPhaseStartedAt clear above, so
    // "Reset & Replay" reproduces clean FORMATION-first conditions every
    // time — the same determinism guarantee v1's own worldMix/
    // worldPhaseStartedAt reset already provided, now extended to cover
    // PART B's new state.
    revealSubStage = "formation";
    formationToTransferAt = 0;
    // Games Arrival Experiment 01 addition: clear Arrival's own state
    // alongside the pre-existing revealSubStage/formationToTransferAt
    // clear above, so "Reset & Replay" reproduces a clean pre-T3 Arrival
    // state too (arrivalOpticalMix back to 1, its no-op value) — the same
    // determinism guarantee this function already provides for every
    // other stage of state, now extended to cover this experiment's
    // addition. Purely additive.
    arrivalPhase = "none";
    arrivalStartedAt = 0;
    arrivalOpticalMix = 1;
    clearWaterFramebuffers();

    // Candidate C, Stage C2 — restore each mode's own canonical resting
    // state. clearWaterFramebuffers() above already flattens both
    // textures and zeroes simulationAccumulator/pendingImpulse for
    // EVERY reset, regardless of mode — that flattening step runs first,
    // unconditionally, so switching FROM c400 TO zero (or vice versa)
    // can never leave residual state from the other mode behind. For
    // c400, the exact snapshot is then loaded on top of that clean flat
    // baseline, so C400's own resting state (even while invisible,
    // solid-phase) already holds the preserved step-400 field, ready to
    // be revealed through the normal liquidMix ramp on the next
    // Activate. For zero, nothing further happens — the resting state is
    // exactly the flat field, byte-identical to the original validated
    // behavior.
    if (stageC2Mode === "c400") {
      // Crossing v3.1: same loadC400Snapshot() fast path as activate()
      // above — see PART A.
      loadC400Snapshot();
      diagCumulativeSteps = 400;
    }

    canvas.classList.remove("is-visible", "mv-canvas--interactive");
    document.body.classList.remove("mv-active");
    document.documentElement.classList.remove("mv-scroll-locked");
    document.body.style.top = "";
    window.scrollTo(0, lockedScrollY);

    activateBtn.disabled = false;
    resetBtn.disabled = true;
    if (modeDiscardBtn) modeDiscardBtn.disabled = false;
    if (modeRetainBtn) modeRetainBtn.disabled = false;
    if (modeZeroBtn) modeZeroBtn.disabled = false;
    if (modeC400Btn) modeC400Btn.disabled = false;
    setStatus("ready", "ready");
  }

  function updateMaterialTransition(now) {
    if (materialPhase === "engaging") {
      const elapsed = now - phaseStartedAt;
      const progress = easeMaterial(elapsed / LIQUID_ENGAGE_DURATION);
      liquidMix = mixNumber(phaseStartingMix, 1, progress);
      if (elapsed >= LIQUID_ENGAGE_DURATION) {
        liquidMix = 1;
        materialPhase = "liquid";
        worldPhaseStartedAt = now; // crossing experiment addition — anchors WORLD_HOLD_DURATION below
        setStatus("liquid", "liquid (holding)");
      }
      return;
    }

    // --- Crossing experiment additions (this pass) ---
    // Everything below is new; the "engaging" branch above (and its
    // early return) is byte-identical in behavior to the locked C400
    // checkpoint. liquidMix is already pinned at 1 by the time any of
    // this runs — none of it touches liquidMix or the water simulation;
    // it only drives worldMix, the new uWorldMix uniform (see
    // MATERIAL_SHADER's blend logic).
    if (materialPhase === "liquid") {
      const heldFor = now - worldPhaseStartedAt;
      if (heldFor >= WORLD_HOLD_DURATION) {
        materialPhase = "revealing";
        worldPhaseStartedAt = now; // re-anchor: now marks the start of FORMATION's own clock
        revealSubStage = "formation"; // v3.1 — explicit, though already this value from reset()/init
        setStatus("liquid", "revealing");
      }
      return;
    }

    // Crossing v3.1 addition (PART B) — replaces v3's single
    // `worldMix = easeMaterial(elapsed / WORLD_REVEAL_DURATION)` ramp
    // with two independently-clocked, independently-eased segments. The
    // shader-facing contract is unchanged: worldMix still ranges
    // continuously and monotonically 0->1 across "revealing", uFormationEnd
    // is still exactly where MATERIAL_SHADER's hard gate sits, and every
    // boundary guarantee proved in v3's NOTE.txt (worldBlend===0 at
    // worldMix<=uFormationEnd, worldBlend===1 at worldMix===1) still holds
    // — only HOW worldMix's value is produced over time changed; the
    // shader that consumes it is byte-identical to v3.
    if (materialPhase === "revealing" && revealSubStage === "formation") {
      const elapsed = now - worldPhaseStartedAt;
      // Linear, not eased: constant nonzero velocity for FORMATION's
      // entire duration, deliberately — smoothstep's own slow start is
      // exactly the "dead hold where nothing happens" the instruction
      // warns against, and FORMATION's own signal (displacement only, no
      // darkening, per this pass's frozen constraint) is already the
      // more subtle of the two stages; it should not also open at
      // near-zero velocity.
      const progress = Math.min(Math.max(elapsed / FORMATION_DURATION, 0), 1);
      worldMix = STAGE_A_FORMATION_END * progress;
      if (elapsed >= FORMATION_DURATION) {
        worldMix = STAGE_A_FORMATION_END;
        revealSubStage = "recognition"; // v3.4: was "transfer" through v3.3 — see the segment split below
        formationToTransferAt = now; // T0: the FORMATION -> FIRST SIGHT event, still the same timestamp semantics as before
        worldPhaseStartedAt = now; // re-anchor: now marks the start of RECOGNITION's own, independent clock
        setStatus("liquid", "revealing"); // status text unchanged — "revealing" still covers all of Stage B/C externally
      }
      return;
    }

    // --- Crossing v3.4 correction (T0-T3 choreography) ---
    // Replaces v3.3's single "transfer" segment (one clock, one linear
    // ramp, 2000ms) with three independently-clocked, independently-eased
    // segments — RECOGNITION, DISCOVERY, PASSAGE — diagnosed as necessary
    // BEFORE this change (defect-analysis/v34-t0t3-dense-diagnosis.js
    // against the unmodified v3.3 build): the old single segment put the
    // first non-zero Games contribution at only +296ms after T0 on both
    // devices, with no dedicated interval for a viewer to register "an
    // opening has formed" first. See the RECOGNITION_DURATION/
    // DISCOVERY_DURATION/PASSAGE_DURATION/DISCOVERY_GAMES_TIME_SPLIT
    // constants above for the full rationale. MATERIAL_SHADER itself is
    // NOT touched by this segment split — worldMix and its derived
    // gamesTimeInput remain exactly the values the shader already expects
    // and already has proven boundary guarantees for; only HOW worldMix
    // reaches those values over time changes, same as every prior pacing
    // correction in this lineage (v3.1, v3.3).
    if (materialPhase === "revealing" && revealSubStage === "recognition") {
      const elapsed = now - worldPhaseStartedAt;
      // worldMix does not move at all during RECOGNITION — held EXACTLY
      // at STAGE_A_FORMATION_END, which by MATERIAL_SHADER's own existing,
      // unchanged boundary proof means gamesTimeInput===0 and
      // worldBlend===0 for every pixel, for this entire interval — Games
      // contribution is zero by construction, not by a new gate. The
      // water simulation (updateWater()/ambientWater()) is NOT paused —
      // it is driven by motionTime/real time independently of worldMix —
      // so the aperture keeps visibly evolving throughout, per
      // instruction section 5 ("the water may continue moving
      // organically... but Games contribution must remain zero").
      worldMix = STAGE_A_FORMATION_END;
      if (elapsed >= RECOGNITION_DURATION) {
        revealSubStage = "discovery";
        worldPhaseStartedAt = now; // re-anchor: DISCOVERY's own independent clock starts now (T1)
      }
      return;
    }

    if (materialPhase === "revealing" && revealSubStage === "discovery") {
      const elapsed = now - worldPhaseStartedAt;
      // Quadratic ease-IN (progress^2): near-zero velocity right at T1,
      // accelerating toward T2 — the deliberate "contained, gradual,
      // still subordinate to Home" first-sight beat instruction section 6
      // asks for. Maps DISCOVERY's own progress 0->1 onto the
      // gamesTimeInput range [0, DISCOVERY_GAMES_TIME_SPLIT] (0.4) — a
      // gamesTimeInput value this pass's own diagnosis of the unchanged
      // shader math (v3.3's checkpoint table) confirmed still keeps
      // home-contribution at ~90% on both devices, i.e. genuinely small
      // and contained, not an arbitrary cutoff.
      const rawProgress = Math.min(Math.max(elapsed / DISCOVERY_DURATION, 0), 1);
      const eased = rawProgress * rawProgress; // ease-in
      const gamesTimeInput = eased * DISCOVERY_GAMES_TIME_SPLIT;
      worldMix = STAGE_A_FORMATION_END + (1 - STAGE_A_FORMATION_END) * gamesTimeInput;
      if (elapsed >= DISCOVERY_DURATION) {
        revealSubStage = "passage";
        worldPhaseStartedAt = now; // re-anchor: PASSAGE's own independent clock starts now (T2)
      }
      return;
    }

    if (materialPhase === "revealing" && revealSubStage === "passage") {
      const elapsed = now - worldPhaseStartedAt;
      // Quadratic ease-OUT (1-(1-progress)^2): fast at T2 (continuing
      // DISCOVERY's exit velocity — "rate of transfer may increase
      // organically"), decelerating toward T3 — "late passage should
      // settle rather than snap," per instruction section 10. Maps
      // PASSAGE's own progress 0->1 onto the REMAINING gamesTimeInput
      // range [DISCOVERY_GAMES_TIME_SPLIT, 1.0].
      const rawProgress = Math.min(Math.max(elapsed / PASSAGE_DURATION, 0), 1);
      const inv = 1 - rawProgress;
      const eased = 1 - inv * inv; // ease-out
      const gamesTimeInput = DISCOVERY_GAMES_TIME_SPLIT + (1 - DISCOVERY_GAMES_TIME_SPLIT) * eased;
      worldMix = STAGE_A_FORMATION_END + (1 - STAGE_A_FORMATION_END) * gamesTimeInput;
      if (elapsed >= PASSAGE_DURATION) {
        worldMix = 1;
        materialPhase = "revealed";
        setStatus("liquid", "revealed (holding)");
      }
      return;
    }
    // materialPhase === "revealed" holds indefinitely — no auto-return, no
    // auto-solidify, no auto-replay loop. Ambient motion keeps running
    // because ambientWater() is a function of uTime alone and is
    // evaluated every frame regardless of simulation/impulse/world state.
    // This is the experiment's required held endpoint (validation item 10).
  }

  // --- Games Arrival Experiment 01 addition ---
  // Entirely additive: reads materialPhase (never writes it), never
  // touches worldMix/liquidMix/revealSubStage/any Crossing-owned state.
  // Only ever produces one visible effect — driving arrivalOpticalMix from
  // 1 (no-op, matches the entire approved Crossing) down to exactly 0 —
  // via the single uArrivalOpticalMix uniform already wired into
  // boundedSlope. Does not touch the underlying water simulation
  // (updateWater/runWaterStep), the ambient analytic field, or any
  // canonical C400 constant (amplitude/refraction/damping/propagation) —
  // per instruction section 8, none of that may be retuned.
  function updateArrival(now) {
    if (materialPhase !== "revealed") {
      // Not at T3 yet — the approved Crossing's own state machine is
      // still running. Arrival stays fully inert (arrivalPhase "none",
      // arrivalOpticalMix pinned at 1, a pure no-op on boundedSlope).
      return;
    }

    if (arrivalPhase === "none") {
      // First frame T3 is observed — anchor Arrival's own independent
      // clock here. This is the "hard boundary" instruction section 2
      // requires: nothing about this frame's materialPhase/worldMix/
      // liquidMix/canvas content changes because of this branch.
      arrivalPhase = "active";
      arrivalStartedAt = now;
    }

    if (arrivalPhase === "active") {
      const elapsed = now - arrivalStartedAt;
      const rawProgress = Math.min(Math.max(elapsed / ARRIVAL_DURATION, 0), 1);
      // Cubic ease-out (1-(1-p)^3): fastest motion immediately after T3,
      // decelerating into the settle — continues the Crossing's own
      // "settle rather than snap" ending quality (PASSAGE_DURATION above
      // uses the same ease-out family, one power lower) rather than
      // introducing an unrelated pacing feel at the exact boundary where
      // continuity matters most (instruction section 3).
      const inv = 1 - rawProgress;
      const eased = 1 - inv * inv * inv;
      arrivalOpticalMix = 1 - eased;
      if (elapsed >= ARRIVAL_DURATION) {
        arrivalOpticalMix = 0;
        arrivalPhase = "stable";
      }
    }
    // arrivalPhase === "stable": arrivalOpticalMix stays pinned at exactly
    // 0 indefinitely — no auto-reset, mirroring materialPhase==="revealed"
    // holding indefinitely above. Reset & Replay (resetBtn) already
    // returns materialPhase to "solid"; that same handler additionally
    // resets arrivalPhase/arrivalOpticalMix back to their initial values
    // (see the Games Arrival Experiment 01 addition inside the reset
    // handler, below), so Reset & Replay reproduces a clean Arrival state
    // too, not just a clean Crossing state.
  }

  function runWaterStep() {
    const sourceIndex = waterResources.readIndex;
    const destIndex = 1 - sourceIndex;
    const hasImpulse = pendingImpulse !== null;
    const propagation = mixNumber(0.275, 0.185, DEFAULTS.viscosity);
    const damping = 1 - mixNumber(0.0007, 0.0042, DEFAULTS.viscosity);
    const impulseStrength = hasImpulse ? 0.075 + DEFAULTS.amplitude * 0.009 : 0;
    const impulseRadius = 0.016 + DEFAULTS.scale * 0.004;
    const impulse = hasImpulse ? pendingImpulse : { x: -2, y: -2 };

    gl.useProgram(waterProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, waterResources.framebuffers[destIndex]);
    gl.viewport(0, 0, waterResources.width, waterResources.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, waterResources.textures[sourceIndex]);
    gl.uniform1i(waterLoc.previousWater, 0);
    gl.uniform2f(waterLoc.waterTexel, 1 / waterResources.width, 1 / waterResources.height);
    gl.uniform1f(waterLoc.aspect, window.innerWidth / Math.max(window.innerHeight, 1));
    gl.uniform1f(waterLoc.propagation, propagation);
    gl.uniform1f(waterLoc.damping, damping);
    gl.uniform2f(waterLoc.impulse, impulse.x, impulse.y);
    gl.uniform1f(waterLoc.impulseRadius, impulseRadius);
    gl.uniform1f(waterLoc.impulseStrength, impulseStrength);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    waterResources.readIndex = destIndex;
    if (hasImpulse) pendingImpulse = null;
  }

  function updateWater(delta, rawDelta) {
    const simulationRate = DEFAULTS.speed * 300;
    // The ONLY branch point for this experiment: which elapsed-time value
    // feeds the accumulator. Mode A uses `delta` (the pre-existing,
    // render-loop-clamped value — identical to the validated original,
    // since rawDelta is simply not read in this mode). Mode B uses
    // `rawDelta`, the true uncapped elapsed time for this frame.
    const effectiveDelta = simulationTimeMode === "retain" ? rawDelta : delta;
    simulationAccumulator += effectiveDelta * simulationRate;
    const accumulatorBeforeStep = simulationAccumulator;
    let stepCount = Math.min(Math.floor(simulationAccumulator), MAX_SIMULATION_STEPS);

    if (pendingImpulse && stepCount === 0) stepCount = 1;
    if (stepCount === 0) return;

    simulationAccumulator = Math.max(simulationAccumulator - stepCount, 0);
    const cappedDiscard = stepCount === MAX_SIMULATION_STEPS && simulationAccumulator > 1;
    if (stepCount === MAX_SIMULATION_STEPS) {
      // Mode A: byte-identical to the original validated behavior —
      // discard everything above 1 step of backlog. Mode B: discard only
      // what's above the much larger, explicitly justified
      // BACKLOG_CEILING_STEPS ceiling — the actual experimental change.
      const ceiling = simulationTimeMode === "retain" ? BACKLOG_CEILING_STEPS : 1;
      if (simulationAccumulator > ceiling) {
        const discarded = simulationAccumulator - ceiling;
        diagDiscardedSimulationSteps += discarded;
        diagLastOverflowDiscard = discarded;
        simulationAccumulator = ceiling;
      }
    }

    for (let i = 0; i < stepCount; i += 1) runWaterStep();

    // Diagnostic-only bookkeeping below — does not affect stepCount,
    // simulationAccumulator, or which/how-many runWaterStep() calls just
    // ran (those already happened, above, unmodified).
    if (diagArmed) {
      diagCumulativeSteps += stepCount;
      diagPushCapped(diagStepHistory, {
        t: diagNow(), delta, accumulatorBefore: accumulatorBeforeStep,
        stepCount, accumulatorAfter: simulationAccumulator,
        cumulativeSteps: diagCumulativeSteps, cappedStepsDiscarded: cappedDiscard
      });
      if (!diagFirstSimUpdateMarked) {
        diagFirstSimUpdateMarked = true;
        diagMark("firstSimulationUpdate", { stepCount, cumulativeSteps: diagCumulativeSteps });
      }
    }
  }

  function update(now) {
    const previousFrameTime = lastFrameTime;
    const delta = Math.min(Math.max((now - lastFrameTime) / 1000, 0), 0.05);
    lastFrameTime = now;
    // motionTime (ambientWater()'s phase) and the engage-ramp keep using
    // the original, render-loop-clamped `delta`, completely unchanged —
    // this experiment only changes the water SIMULATION's own clock, not
    // the ambient overlay or the activation ramp.
    motionTime += delta * DEFAULTS.speed * MOTION_RATE;
    updateMaterialTransition(now);
    // Games Arrival Experiment 01 addition: evaluated every frame, after
    // updateMaterialTransition(now) has already run for this frame — so
    // Arrival only ever observes a materialPhase value the approved
    // Crossing's own logic has already finished settling for this tick.
    // Purely additive; does not change delta, motionTime, or anything
    // updateWater() below reads.
    updateArrival(now);
    // True, uncapped elapsed time since the last update() call — only
    // used by updateWater() in mode B ("retain"); mode A never reads it.
    const rawDelta = Math.max((now - previousFrameTime) / 1000, 0);
    updateWater(delta, rawDelta);
  }

  function draw() {
    gl.useProgram(materialProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textureObjects.get(activeTextureKey));
    gl.uniform1i(materialLoc.home, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, waterResources.textures[waterResources.readIndex]);
    gl.uniform1i(materialLoc.water, 1);
    // Crossing experiment addition (this pass): the Games texture, bound
    // on its own texture unit exactly like uHome/uWater above — no other
    // binding on units 0/1 is touched.
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, gamesTextureObjects.get(activeTextureKey));
    gl.uniform1i(materialLoc.games, 2);

    gl.uniform2f(materialLoc.resolution, canvas.width, canvas.height);
    gl.uniform2f(materialLoc.waterTexel, 1 / waterResources.width, 1 / waterResources.height);
    // v2/v3: display amplitude only (physics/impulse-strength amplitude is
    // untouched below in runWaterStep, still DEFAULTS.amplitude). The
    // per-device table (v3) is picked by currentAmplitudeTable(), then
    // scaled by dprCapped exactly as v2 did, so the CSS-pixel-equivalent
    // displacement matches the selected variant's label within a given
    // device class, regardless of its real DPR.
    gl.uniform1f(materialLoc.amplitude, currentAmplitudeTable()[currentVariant] * dprCapped);
    gl.uniform1f(materialLoc.scale, DEFAULTS.scale);
    gl.uniform1f(materialLoc.viscosity, DEFAULTS.viscosity);
    gl.uniform1f(materialLoc.time, motionTime);
    gl.uniform1f(materialLoc.liquidMix, liquidMix);
    gl.uniform2f(materialLoc.coverScale, coverMapping.scaleX, coverMapping.scaleY);
    gl.uniform2f(materialLoc.coverOffset, coverMapping.offsetX, coverMapping.offsetY);
    // Crossing experiment addition (v1/v2): the only other new uniform
    // besides uGames above, until v3's addition immediately below.
    // Everything else in draw() above and below this line is unchanged
    // from the locked C400 checkpoint.
    gl.uniform1f(materialLoc.worldMix, worldMix);
    // Crossing v3 addition: single source of truth is the JS constant
    // STAGE_A_FORMATION_END, set every frame here (cheap — one float
    // uniform upload) so the shader-side gate can never drift from the
    // JS-side stage boundary the report describes.
    gl.uniform1f(materialLoc.formationEnd, STAGE_A_FORMATION_END);
    // Games Arrival Experiment 01 addition: 1.0 for the entire approved
    // Crossing (a pure no-op — see uArrivalOpticalMix's shader-side
    // comment), only ever driven below 1.0 by updateArrival(), which
    // never runs before materialPhase==="revealed" (T3).
    gl.uniform1f(materialLoc.arrivalOpticalMix, arrivalOpticalMix);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Diagnostic-only marks below — read state that draw() just used
    // (liquidMix, diagCumulativeSteps) but do not change what was just
    // submitted to the GPU above.
    if (diagArmed) {
      if (!diagFirstDrawMarked) {
        diagFirstDrawMarked = true;
        diagMark("firstDraw");
      }
      // Proxy for "first frame in which non-zero deformation should be
      // visible": liquidMix > 0 (the shader's *uLiquidMix factor is
      // nonzero) AND at least one simulation step has actually executed
      // (so the impulse has begun propagating, not just the ambient
      // field). This is the earliest frame where refractionPixels in
      // MATERIAL_SHADER can be non-zero from something other than the
      // pre-existing ambient wave motion.
      if (!diagFirstDeformationFrameMarked && liquidMix > 0 && diagCumulativeSteps > 0) {
        diagFirstDeformationFrameMarked = true;
        diagMark("firstFrameWithExpectedDeformation", { liquidMix, cumulativeSteps: diagCumulativeSteps });
      }
    }
  }

  function updateFpsReadout(now) {
    fpsFrameCount += 1;
    if (now - fpsWindowStart >= 500) {
      const windowMs = now - fpsWindowStart;
      const fps = Math.round((fpsFrameCount * 1000) / windowMs);
      if (fpsEl) fpsEl.textContent = `${fps} fps`;
      // Stored for the real-device-AB-test-artifact's combined live
      // readout below — same 500ms-window average the fps figure
      // itself already uses, just also expressed as ms/frame.
      lastFpsValue = fps;
      lastFrameTimeMs = windowMs / fpsFrameCount;
      fpsFrameCount = 0;
      fpsWindowStart = now;
    }
  }

  // Real-device-AB-test-artifact-only (this pass). Combined, compact
  // status line: mode / state / wall-clock age since activation /
  // simulation age / backlog / fps / frame time — everything the
  // real-device protocol asks to see at a glance, in one small strip.
  // Read-only with respect to material state: reads materialPhase,
  // liquidMix, phaseStartedAt (already set by activate(), unchanged),
  // simulationTimeMode, diagCumulativeSteps, simulationAccumulator, and
  // the fps/frame-time values updateFpsReadout() just computed above —
  // writes nothing back except this text node.
  // Candidate C, Stage C2 — deliberately minimal, per instruction ("keep
  // diagnostics very small... at minimum show: mode; phase; wall-clock
  // age; simulation age/step count; FPS"). Replaces the DISCARD/RETAIN
  // pass's own live-readout text (mode/backlog fields no longer apply —
  // simulationTimeMode is hardcoded, not a variable under test here).
  // Read-only: reads stageC2Mode, materialPhase, phaseStartedAt,
  // diagCumulativeSteps, lastFpsValue — writes nothing back except this
  // text node.
  function updateLiveReadout(now) {
    if (!liveReadoutEl) return;
    const simulationRate = DEFAULTS.speed * 300;
    const modeLabel = stageC2Mode === "c400" ? "C400" : "ZERO";
    const stateLabel = materialPhase; // "solid" | "engaging" | "liquid" | "revealing" | "revealed"
    const wallClockAgeS = materialPhase === "solid" ? 0 : Math.max(0, (now - phaseStartedAt) / 1000);
    const simAgeS = diagCumulativeSteps / simulationRate;
    const fpsText = lastFpsValue === null ? "—" : String(lastFpsValue);
    // Crossing v1/v2 addition, RECOMPUTED for v3 (this pass): a coarse,
    // GLOBAL Home/Games contribution readout. v1/v2 read this directly
    // off raw worldMix (1-worldMix / worldMix); that would now be
    // actively misleading, since v3's MATERIAL_SHADER gates games
    // contribution to exactly zero until worldMix passes
    // STAGE_A_FORMATION_END (see material-engine.js's gamesTimeInput) —
    // displaying raw worldMix here would show a nonzero "games%" during
    // Stage A even though not a single Games pixel is contributing to
    // gl_FragColor anywhere on the canvas. gamesTimeInputJs mirrors the
    // shader's own gamesTimeInput formula exactly (JS-side restatement of
    // the same remap, for the diagnostic strip only — does not feed back
    // into any uniform or state), so what this strip reports matches what
    // the shader is actually doing. stageLabel is the new addition this
    // pass: which of the three ordered stages worldMix currently falls
    // in. v3.1: now read directly off revealSubStage (the internal
    // ground truth PART B's own independently-clocked segments set),
    // rather than re-derived from a worldMix/STAGE_A_FORMATION_END
    // comparison — semantically the same boundary, but this avoids any
    // possible float-precision mismatch between the two, and is accurate
    // even in the one frame where FORMATION completes exactly at
    // worldMix===STAGE_A_FORMATION_END. B and C are not spatially/
    // temporally separated by a hard boundary (see NOTE.txt), so both
    // are still reported together as "B/C:reveal" once in the transfer
    // sub-stage.
    // v3.4: revealSubStage now has four values instead of two — label each
    // distinctly on the diagnostic strip (T0/T1/T2/T3 naming, matching the
    // instruction's own vocabulary) so a real-device recording can show
    // exactly which named segment is active at every frame, not just an
    // inferred "before/after" split.
    const STAGE_LABELS = {
      formation: "A:formation",
      recognition: "B0:recognition",
      discovery: "B1:discovery",
      passage: "C:passage"
    };
    const stageLabel = materialPhase === "revealing"
      ? (STAGE_LABELS[revealSubStage] || "B/C:reveal")
      : (worldMix <= STAGE_A_FORMATION_END ? "A:formation" : "C:passage");
    const gamesTimeInputJs = Math.min(1, Math.max(0,
      (worldMix - STAGE_A_FORMATION_END) / Math.max(1 - STAGE_A_FORMATION_END, 0.0001)
    ));
    const homePct = Math.round((1 - gamesTimeInputJs) * 100);
    const gamesPct = Math.round(gamesTimeInputJs * 100);
    // Games Arrival Experiment 01 addition: a separate "arrival:" field on
    // the diagnostic strip, per instruction section 17 — CROSSING for the
    // entire approved sequence through T3 (byte/behavior-identical to the
    // locked checkpoint's own stage/phase/age/steps/fps/home-games%
    // reporting above, untouched), T3 for the single frame Arrival's own
    // clock has not yet started, ARRIVAL while arrivalOpticalMix is
    // ramping, STABLE once pinned at exactly 0 — so a real-device
    // recording can show exactly where the hard boundary falls.
    const arrivalLabel = materialPhase !== "revealed"
      ? "CROSSING"
      : (arrivalPhase === "none" ? "T3" : arrivalPhase === "active" ? "ARRIVAL" : "STABLE");
    liveReadoutEl.textContent =
      `mode: ${modeLabel} · phase: ${stateLabel} · stage: ${stageLabel} · age: ${wallClockAgeS.toFixed(1)}s · ` +
      `steps: ${diagCumulativeSteps} (~${simAgeS.toFixed(1)}s) · ${fpsText} fps · ` +
      `home/games: ${homePct}/${gamesPct}% (global, gated) · arrival: ${arrivalLabel}`;
  }

  function render(now) {
    // rAF-gap tracking runs every frame regardless of activation state
    // (diagArmed), because a stall that matters to the desktop-hitch
    // question can start before activate() is even clicked (e.g. a
    // long task queued right at click time may show up as the gap
    // ENDING just after activation) — gating this on diagArmed would
    // throw away exactly the data most likely to explain the hitch.
    // This only ever reads `now` and diagLastRafTime and appends to
    // capped arrays; it does not alter `now` or anything render()/
    // update()/draw() below it use.
    if (diagLastRafTime !== null) {
      const gap = now - diagLastRafTime;
      diagPushCapped(diagRafGaps, { t: now, gap });
      if (gap > DIAG_STALL_THRESHOLD_MS) {
        diagPushCapped(diagRafStalls, { t: now, gap, duringActivation: diagArmed });
      }
    }
    diagLastRafTime = now;
    if (diagArmed && !diagFirstRafMarked) {
      diagFirstRafMarked = true;
      diagMark("firstRequestAnimationFrame");
    }

    update(now);
    draw();
    updateFpsReadout(now);
    updateLiveReadout(now);
    frameRequest = requestAnimationFrame(render);
  }

  function pointerPosition(event) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: Math.min(Math.max((event.clientX - bounds.left) / Math.max(bounds.width, 1), 0), 1),
      y: Math.min(Math.max(1 - (event.clientY - bounds.top) / Math.max(bounds.height, 1), 0), 1)
    };
  }

  // Sets which A/B/C level draw() reads next frame. Deliberately touches
  // NOTHING else: no canvas resize, no WebGL resource (re)creation, no
  // change to waterResources/liquidMix/materialPhase/motionTime. The
  // running simulation and the held liquid state are completely
  // unaffected by which variant is selected.
  function setVariant(key) {
    if (!VARIANT_ORDER.includes(key)) return; // valid in both tables (A/B/C only)
    currentVariant = key;
    // Real-device-AB-test-artifact note: the A/B/C buttons are not part
    // of this page's UI (removed to keep the strip small and focused on
    // the DISCARD/RETAIN comparison — amplitude stays fixed at A, set
    // once below in initialize(), exactly as in the locked checkpoint).
    // variantButtons[key] is therefore null here; guarded so the one
    // startup call to setVariant("A") does not throw.
    for (const [k, btn] of Object.entries(variantButtons)) {
      if (btn) btn.setAttribute("aria-pressed", String(k === key));
    }
    updateAmplitudeReadout();
  }

  function bindControls() {
    // Diagnostic-only: a pointerdown listener fires strictly before the
    // browser's own click event, giving the earliest available timestamp
    // for "user physically pressed the button." It does not call
    // preventDefault/stopPropagation and does not touch materialPhase,
    // so the original click->activate() path below is completely
    // unaffected — this listener only records a timestamp.
    // Note: diagArmed is still false at this point (activate() hasn't
    // run yet, so diagResetForNewActivation() hasn't armed it) — so this
    // mark cannot go through diagMark(), which requires diagArmed. It's
    // buffered separately in diagPointerdowns and merged into the
    // timeline export in exportAll() below, tagged with the seq number
    // the FOLLOWING activation will get (diagActivationSeq + 1), since
    // that's the activation this pointerdown is presumably for.
    activateBtn.addEventListener("pointerdown", () => {
      diagPushCapped(diagPointerdowns, { t: diagNow(), forSeq: diagActivationSeq + 1 });
    });

    // Diagnostic-only: wraps (does not replace) the original click
    // listener so a "click" mark can be recorded. activate() itself
    // marks "activate:handlerEntry" as its own first statement and, as
    // part of that, calls diagResetForNewActivation() which clears the
    // timeline for the new activation — so the click timestamp is taken
    // BEFORE calling activate() and then spliced in as the timeline's
    // first entry immediately after, restoring correct chronological
    // order without changing when activate() itself runs or what it does.
    activateBtn.addEventListener("click", () => {
      const clickAt = diagNow();
      activate();
      diagActivationTimeline.unshift({ label: "click", t: clickAt, seq: diagActivationSeq });
    });
    resetBtn.addEventListener("click", reset);

    // Crossing experiment addition (this pass): "Hide controls" is a
    // pure CSS visibility toggle on #mv-controls (mv-controls-hidden,
    // material-harness.css) — it does not touch materialPhase, worldMix,
    // liquidMix, any canvas/GL resource, or the render loop. update()/
    // draw() keep running identically whether the strip is shown or
    // hidden (per instruction: "Hiding controls must not affect the
    // rendering pipeline").
    if (hideControlsBtn) {
      hideControlsBtn.addEventListener("click", () => {
        const nowHidden = controlsEl.classList.toggle("mv-controls-hidden");
        hideControlsBtn.textContent = nowHidden ? "Show controls" : "Hide controls";
      });
    }
    // A/B/C buttons are not part of this page's HTML (see setVariant's
    // comment) — variantButtons[key] is null, so this loop is guarded to
    // a no-op rather than removed outright, keeping this block a direct,
    // minimal diff from the locked checkpoint's bindControls().
    for (const key of VARIANT_ORDER) {
      if (variantButtons[key]) variantButtons[key].addEventListener("click", () => setVariant(key));
    }

    // Real-device-AB-test-artifact-only: the DISCARD/RETAIN selector.
    // Mirrors setVariant()'s own contract exactly — touches ONLY
    // simulationTimeMode (read by updateWater()'s effectiveDelta branch)
    // and this pair of buttons' pressed state. No canvas/GL/simulation
    // resource is created, resized, or reset by switching mode; no
    // uniform is touched. Disabled while phase !== "solid" so a mode
    // switch can never happen mid-run and contaminate a comparison —
    // the required protocol is always Reset -> pick mode -> Activate.
    function setMode(mode) {
      if (materialPhase !== "solid") return; // guard mirrors the buttons' own disabled state
      window.__mvExperiment.setMode(mode);
      if (modeDiscardBtn) modeDiscardBtn.setAttribute("aria-pressed", String(mode === "discard"));
      if (modeRetainBtn) modeRetainBtn.setAttribute("aria-pressed", String(mode === "retain"));
    }
    if (modeDiscardBtn) modeDiscardBtn.addEventListener("click", () => setMode("discard"));
    if (modeRetainBtn) modeRetainBtn.addEventListener("click", () => setMode("retain"));

    // Candidate C, Stage C2 — the ZERO | C400 selector. Same contract as
    // setMode() above: only touches stageC2Mode (read exclusively by
    // activate()/reset() and the live readout) and this pair of buttons'
    // pressed state. No canvas/GL/simulation resource is created,
    // resized, or reset by switching mode; no uniform is touched.
    // Disabled outside "solid" so the choice can only be made between
    // Reset and Activate — the required protocol is always
    // Reset -> pick mode -> Activate, never a mid-run switch.
    function setStageC2Mode(mode) {
      if (materialPhase !== "solid") return;
      stageC2Mode = mode;
      if (modeZeroBtn) modeZeroBtn.setAttribute("aria-pressed", String(mode === "zero"));
      if (modeC400Btn) modeC400Btn.setAttribute("aria-pressed", String(mode === "c400"));
    }
    if (modeZeroBtn) modeZeroBtn.addEventListener("click", () => setStageC2Mode("zero"));
    if (modeC400Btn) modeC400Btn.addEventListener("click", () => setStageC2Mode("c400"));

    // Once liquid, a click/tap on the canvas introduces an additional
    // physical disturbance into the already-running surface — this is the
    // recovered engine's own click-to-impulse behavior, just without the
    // "must land on a link" restriction (there is no link here).
    canvas.addEventListener("click", (event) => {
      if (materialPhase === "solid") return;
      triggerImpulse(pointerPosition(event));
    });

    canvas.addEventListener("touchstart", (event) => {
      if (materialPhase === "solid") return;
      // Prevent the touch from reaching (and scrolling) anything else —
      // the canvas is the only interactive surface while active.
      event.preventDefault();
      const touch = event.touches[0];
      if (touch) {
        triggerImpulse(pointerPosition({ clientX: touch.clientX, clientY: touch.clientY }));
      }
    }, { passive: false });

    // Diagnostics-pass-only: "Copy Diagnostics" only reads state (via
    // window.__mvDiag.exportAll(), built further down in initialize())
    // and writes to the clipboard/a hidden textarea — it never calls
    // activate/reset/setVariant and never touches materialPhase, so it
    // cannot affect the running simulation or liquid state in any way.
    // This is how the real-device timestamp/long-task/step data gets
    // off the EliteBook without opening devtools.
    if (copyDiagBtn) {
      copyDiagBtn.addEventListener("click", async () => {
        if (!window.__mvDiag) {
          if (copyDiagStatusEl) copyDiagStatusEl.textContent = "not ready";
          return;
        }
        const payload = JSON.stringify(window.__mvDiag.exportAll(), null, 2);
        let copied = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(payload);
            copied = true;
          }
        } catch (clipboardError) {
          copied = false;
        }
        if (!copied && diagFallbackTextarea) {
          try {
            diagFallbackTextarea.value = payload;
            diagFallbackTextarea.style.opacity = "1"; // must be visible/selectable for execCommand in some browsers
            diagFallbackTextarea.focus();
            diagFallbackTextarea.select();
            copied = document.execCommand && document.execCommand("copy");
            diagFallbackTextarea.style.opacity = "0";
          } catch (execError) {
            copied = false;
          }
        }
        if (copyDiagStatusEl) {
          copyDiagStatusEl.textContent = copied
            ? `copied (${payload.length} chars)`
            : "copy failed — select #mv-diag-fallback manually";
        }
      });
    }
  }

  async function loadManifest() {
    if (window.__MV_MANIFEST_INLINE__) {
      return window.__MV_MANIFEST_INLINE__;
    }
    const res = await fetch("prebaked/mv-manifest.json");
    if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
    return res.json();
  }

  async function initialize() {
    setStatus("idle", "loading…");

    gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance"
    });

    if (!gl) {
      setStatus("fallback", "webgl unavailable");
      return;
    }

    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      cancelAnimationFrame(frameRequest);
      setStatus("fallback", "context lost");
    }, { once: true });

    // Diagnostic-only, feature-detected: long tasks (>=50ms main-thread
    // blocks) are exactly the kind of thing that could explain a
    // click-to-visible-motion hitch that isn't visible in our own
    // rAF-gap tracking (a long task ending mid-frame doesn't necessarily
    // show up as a big gap between two rAF timestamps if it happens to
    // land before the next rAF is scheduled rather than during it).
    // Not supported in every browser (notably not in older Safari/iOS
    // WebKit at time of writing) — degrades to an empty diagLongTasks
    // array with no error if PerformanceObserver or the "longtask" entry
    // type is unavailable, never throws, never blocks initialize().
    try {
      if (typeof PerformanceObserver !== "undefined" &&
          PerformanceObserver.supportedEntryTypes &&
          PerformanceObserver.supportedEntryTypes.includes("longtask")) {
        const longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            diagPushCapped(diagLongTasks, {
              t: entry.startTime,
              duration: entry.duration,
              name: entry.name,
              attribution: (entry.attribution || []).map((a) => ({
                name: a.name, containerType: a.containerType, containerSrc: a.containerSrc
              }))
            });
          }
        });
        longTaskObserver.observe({ entryTypes: ["longtask"] });
      }
    } catch (observerError) {
      // Non-fatal: diagLongTasks simply stays empty. The report will say
      // so explicitly rather than implying long-task data was captured
      // when the browser didn't support it.
    }

    try {
      manifestEntries = await loadManifest();
      materialProgram = createProgram(MATERIAL_SHADER);
      waterProgram = createProgram(WATER_SHADER);
      createGeometry();

      materialLoc = {
        home: gl.getUniformLocation(materialProgram, "uHome"),
        water: gl.getUniformLocation(materialProgram, "uWater"),
        resolution: gl.getUniformLocation(materialProgram, "uResolution"),
        waterTexel: gl.getUniformLocation(materialProgram, "uWaterTexel"),
        amplitude: gl.getUniformLocation(materialProgram, "uAmplitude"),
        scale: gl.getUniformLocation(materialProgram, "uScale"),
        viscosity: gl.getUniformLocation(materialProgram, "uViscosity"),
        time: gl.getUniformLocation(materialProgram, "uTime"),
        liquidMix: gl.getUniformLocation(materialProgram, "uLiquidMix"),
        coverScale: gl.getUniformLocation(materialProgram, "uCoverScale"),
        coverOffset: gl.getUniformLocation(materialProgram, "uCoverOffset"),
        // Crossing experiment additions (v1/v2).
        games: gl.getUniformLocation(materialProgram, "uGames"),
        worldMix: gl.getUniformLocation(materialProgram, "uWorldMix"),
        // Crossing v3 addition.
        formationEnd: gl.getUniformLocation(materialProgram, "uFormationEnd"),
        // Games Arrival Experiment 01 addition.
        arrivalOpticalMix: gl.getUniformLocation(materialProgram, "uArrivalOpticalMix")
      };
      waterLoc = {
        previousWater: gl.getUniformLocation(waterProgram, "uPreviousWater"),
        waterTexel: gl.getUniformLocation(waterProgram, "uWaterTexel"),
        aspect: gl.getUniformLocation(waterProgram, "uAspect"),
        propagation: gl.getUniformLocation(waterProgram, "uPropagation"),
        damping: gl.getUniformLocation(waterProgram, "uDamping"),
        impulse: gl.getUniformLocation(waterProgram, "uImpulse"),
        impulseRadius: gl.getUniformLocation(waterProgram, "uImpulseRadius"),
        impulseStrength: gl.getUniformLocation(waterProgram, "uImpulseStrength")
      };

      activeTextureKey = selectTextureKey();

      const entries = await Promise.all(
        Object.entries(TEXTURES).map(async ([key, def]) => {
          const image = await loadImage(def.file);
          // v3.3 diagnosis-only: capture CPU-readable pixels alongside the
          // existing GPU upload. Does not alter uploadTexture(image) below.
          homePixelCache.set(key, capturePixelDataDiag(image));
          return [key, uploadTexture(image)];
        })
      );
      for (const [key, texture] of entries) textureObjects.set(key, texture);

      // Crossing experiment addition (this pass): mirrors the Home
      // texture-loading block immediately above, using the SAME
      // loadImage()/uploadTexture() helpers, loaded from GAMES_TEXTURES
      // instead of TEXTURES. Independent Promise.all — does not alter or
      // depend on the Home load above in any way.
      const gamesEntries = await Promise.all(
        Object.entries(GAMES_TEXTURES).map(async ([key, def]) => {
          const image = await loadImage(def.file);
          // v3.3 diagnosis-only: same CPU-readable capture as Home, above.
          gamesPixelCache.set(key, capturePixelDataDiag(image));
          return [key, uploadTexture(image)];
        })
      );
      for (const [key, texture] of gamesEntries) gamesTextureObjects.set(key, texture);

      resizeCanvas();
      bindControls();
      setVariant("A"); // default on load; also syncs button aria-pressed state
      window.addEventListener("resize", resizeCanvas, { passive: true });
      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", resizeCanvas, { passive: true });
      }

      activateBtn.disabled = false;
      resetBtn.disabled = true;
      if (modeDiscardBtn) modeDiscardBtn.disabled = false;
      if (modeRetainBtn) modeRetainBtn.disabled = false;
      setStatus("ready", "ready");

      lastFrameTime = performance.now();
      fpsWindowStart = lastFrameTime;
      frameRequest = requestAnimationFrame(render);

      // Exposed for the verification harness only (screenshot-diff /
      // pixel-zero-identity checks). Not part of the UI/control surface —
      // no button calls these, and forceCanvasVisible only toggles the
      // opacity class used for the pixel-identity check itself; it does
      // not resize/recreate/pause the canvas or touch simulation state.
      window.__mvDebug = {
        getPhase: () => materialPhase,
        getLiquidMix: () => liquidMix,
        activate,
        reset,
        forceCanvasVisible: (visible) => canvas.classList.toggle("is-visible", visible),
        getVariant: () => currentVariant,
        setVariant,
        // Exact numbers actually reaching the shader/screen right now —
        // for verification and for the report, not for display in the UI.
        getAmplitudeInfo: () => ({
          variant: currentVariant,
          deviceClass: activeTextureKey, // "mobile" | "desktop" — which table is active
          cssPxTarget: currentAmplitudeTable()[currentVariant],
          dprCapped,
          shaderUAmplitude: currentAmplitudeTable()[currentVariant] * dprCapped,
          canvasWidthPx: canvas.width,
          canvasHeightPx: canvas.height
        }),
        // Crossing v3.1 addition — verification-only visibility into
        // PART A's prewarm cache, independent of diagArmed's
        // activation-scoped gating (so it can be inspected even before
        // any activation has happened).
        getPrewarmState: () => ({
          ready: !!prewarmedC400,
          width: prewarmedC400 ? prewarmedC400.width : null,
          height: prewarmedC400 ? prewarmedC400.height : null,
          scheduled: prewarmScheduled,
          log: prewarmLog.slice()
        })
      };

      // window.__mvDiag: the diagnostic-only surface for this pass.
      // Entirely separate from __mvDebug above (which predates this
      // pass and stays exactly as it was). Nothing here is wired to any
      // button except the optional "Copy Diagnostics" control, which
      // only calls exportAll() + writes to the clipboard — it does not
      // call activate/reset/setVariant or touch simulation state.
      window.__mvDiag = {
        // Point-in-time reads, safe to call at any moment (including
        // before any activation, or with WebGL not yet ready — see the
        // {available:false, reason} shape computeFieldStats() returns
        // in that case).
        getSnapshot: () => diagGetSnapshot(),
        getFieldStats: () => computeFieldStats(),

        // Logs accumulated since the current/most-recent activation
        // (or, for rAF gaps/long tasks, since page load — see the
        // comment on rAF-gap tracking in render() for why those two are
        // not scoped to a single activation).
        getActivationTimeline: () => diagActivationTimeline.slice(),
        getStepHistory: () => diagStepHistory.slice(),
        getRafGaps: () => diagRafGaps.slice(),
        getRafStalls: () => diagRafStalls.slice(),
        getLongTasks: () => diagLongTasks.slice(),
        getPointerdowns: () => diagPointerdowns.slice(),

        // Everything above, bundled as one JSON-serializable object —
        // this is what the "Copy Diagnostics" button copies, and what a
        // real-device test session should call and paste back for the
        // report, since the sandbox cannot reproduce the EliteBook's
        // actual hitch.
        exportAll: () => ({
          exportedAt: diagNow(),
          userAgent: navigator.userAgent,
          devicePixelRatio: window.devicePixelRatio,
          dprCapped,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          deviceClass: activeTextureKey,
          activationSeq: diagActivationSeq,
          snapshot: diagGetSnapshot(),
          activationTimeline: diagActivationTimeline.slice(),
          stepHistory: diagStepHistory.slice(),
          rafGaps: diagRafGaps.slice(),
          rafStalls: diagRafStalls.slice(),
          longTasks: diagLongTasks.slice(),
          pointerdowns: diagPointerdowns.slice(),
          longTaskApiSupported: !!(typeof PerformanceObserver !== "undefined" &&
            PerformanceObserver.supportedEntryTypes &&
            PerformanceObserver.supportedEntryTypes.includes("longtask"))
        }),

        resetActivationDiagnostics: () => diagResetForNewActivation()
      };

      // window.__mvExperiment: this pass's A/B surface. Not wired to any
      // UI control — mode defaults to "discard" (A, byte-identical to
      // the validated original) and only changes via an explicit
      // setMode("retain") call from a test harness. Switching modes
      // never touches canvas/GL resources, activate()/reset(), or any
      // uniform — see updateWater()'s `effectiveDelta` branch, the only
      // place mode is actually read.
      window.__mvExperiment = {
        getMode: () => simulationTimeMode,
        setMode: (mode) => {
          if (mode !== "discard" && mode !== "retain") return false;
          simulationTimeMode = mode;
          return true;
        },
        getBacklogCeilingSteps: () => (simulationTimeMode === "retain" ? BACKLOG_CEILING_STEPS : 1),
        getDiscardedSimulationSteps: () => diagDiscardedSimulationSteps,
        getAccumulatorBacklogSteps: () => simulationAccumulator,
        getSimulationAgeSeconds: () => diagCumulativeSteps / (DEFAULTS.speed * 300),

        // Identity-check helper ONLY (item 6: matched-simulation-age
        // comparison). Bypasses ALL timing/accumulator/mode logic and
        // calls runWaterStep() directly N times — the exact same
        // function both modes call internally, so driving A and B to
        // the same forced step count and comparing computeFieldStats()
        // output is a direct test of "does the bookkeeping change alter
        // the water itself," independent of real-time rendering
        // variability. Requires an activation already in progress
        // (pendingImpulse must have already been consumed once, or the
        // very first forced step consumes it) — does not call activate()
        // itself.
        forceSimulationSteps: (n) => {
          const count = Math.max(0, Math.floor(n) || 0);
          for (let i = 0; i < count; i += 1) runWaterStep();
          if (diagArmed) diagCumulativeSteps += count;
          return count;
        },

        // Test-only pause/resume of the render loop itself. The real
        // requestAnimationFrame(render) loop keeps running in the
        // background at all times otherwise — including during the
        // wall-clock gaps between Playwright's own page.evaluate() calls
        // — which would silently add extra, uncontrolled real-time steps
        // on top of forceSimulationSteps() and contaminate an identity
        // check that's supposed to isolate step-count as the only
        // variable. Pausing/resuming does not touch materialPhase,
        // liquidMix, canvas visibility, or any GL resource — draw() and
        // updateFpsReadout() simply stop/resume being called each frame.
        pauseRenderLoop: () => { cancelAnimationFrame(frameRequest); },
        resumeRenderLoop: () => {
          lastFrameTime = performance.now(); // avoid a huge delta from the paused gap
          frameRequest = requestAnimationFrame(render);
        }
      };

      // window.__mvCandidateC2: Stage C2's own verification/test surface.
      // Not wired to any UI control beyond the ZERO|C400 buttons
      // themselves (bindControls(), above). getMode/setMode duplicate
      // what the buttons already do, for a test harness driving the page
      // headlessly. captureWaterState/loadWaterState are the same
      // Stage-C1 functions, exposed here for verification (e.g.
      // confirming Reset restores the exact snapshot). getSnapshotHash
      // is a convenience for the report's "proof that C400 uses the
      // exact hash-locked C1 snapshot" requirement — SubtleCrypto is
      // available in both the dev server (http://localhost, a secure
      // context) and the file:// standalone bundle in Chromium.
      window.__mvCandidateC2 = {
        getMode: () => stageC2Mode,
        setMode: (mode) => {
          if (mode !== "zero" && mode !== "c400") return false;
          if (materialPhase !== "solid") return false;
          stageC2Mode = mode;
          if (modeZeroBtn) modeZeroBtn.setAttribute("aria-pressed", String(mode === "zero"));
          if (modeC400Btn) modeC400Btn.setAttribute("aria-pressed", String(mode === "c400"));
          return true;
        },
        captureWaterState: () => captureWaterState(),
        loadWaterState: (pixelsBase64, width, height) => loadWaterState(pixelsBase64, width, height),
        // v3.1 addition — verification-only: forces loadC400Snapshot()'s
        // NEXT call to take the synchronous fallback path (byte-identical
        // to v3's original loadWaterState() call) regardless of whether a
        // valid prewarmed buffer exists, so a test can capture both paths'
        // GPU-uploaded result and diff them for exact byte equality
        // (NOTE.txt validation #20). Does not touch waterResources, the
        // GPU, or any simulation state itself — only clears the cached
        // JS buffer; schedulePrewarmC400() will repopulate it normally on
        // the next resize, or a test can call it directly.
        clearPrewarmCache: () => { prewarmedC400 = null; },
        getPrewarmState: () => ({
          ready: !!prewarmedC400,
          width: prewarmedC400 ? prewarmedC400.width : null,
          height: prewarmedC400 ? prewarmedC400.height : null
        }),
        getEmbeddedSnapshotMeta: () => ({
          width: CANDIDATE_C1_SNAPSHOT_STEP400.width,
          height: CANDIDATE_C1_SNAPSHOT_STEP400.height,
          pixelsBase64Length: CANDIDATE_C1_SNAPSHOT_STEP400.pixelsBase64.length
        }),
        getLiquidMix: () => liquidMix,
        getPhaseStartingMix: () => phaseStartingMix,
        getPendingImpulse: () => pendingImpulse,
        getDiagCumulativeSteps: () => diagCumulativeSteps,
        // Round 2 additions — verification surface for the grid-mismatch
        // fix. getLiveGridDims reports the ACTUAL live simulation grid on
        // this device (createWaterResources()'s output, window-size
        // dependent); getLastLoadInfo reports what the most recent
        // loadWaterState() call actually did, including whether it had to
        // resample.
        getLiveGridDims: () => (waterResources ? { width: waterResources.width, height: waterResources.height } : null),
        getLastLoadInfo: () => lastLoadInfo
      };

      // window.__mvCrossing: this pass's own verification surface, for the
      // Home -> Games material-continuity experiment. Read-only except
      // hideControls/showControls, which only toggle a CSS class on
      // #mv-controls (see material-harness.css) — no canvas/GL/simulation
      // state is touched by either.
      window.__mvCrossing = {
        getPhase: () => materialPhase, // "solid" | "engaging" | "liquid" | "revealing" | "revealed"
        getWorldMix: () => worldMix,
        getWorldPhaseStartedAt: () => worldPhaseStartedAt,
        getWorldDurations: () => ({
          hold: WORLD_HOLD_DURATION,
          reveal: WORLD_REVEAL_DURATION, // now a derived total (FORMATION_DURATION + REVEAL_TRANSFER_DURATION), see below
          formation: FORMATION_DURATION,
          transfer: REVEAL_TRANSFER_DURATION, // retained: sum of the three v3.4 segments below, for anything reading the old combined figure
          // v3.4 additions — the three independent segments this pass split "transfer" into:
          recognition: RECOGNITION_DURATION,
          discovery: DISCOVERY_DURATION,
          passage: PASSAGE_DURATION
        }),
        // v3.1 additions — internal ground truth for the FORMATION ->
        // FIRST SIGHT event, for verification/reporting.
        getRevealSubStage: () => revealSubStage, // v3.4: "formation" | "recognition" | "discovery" | "passage" — meaningful only while getPhase()==="revealing"
        getFormationToTransferAt: () => formationToTransferAt, // performance.now() timestamp of the last FORMATION -> FIRST SIGHT event, 0 if not yet reached this activation
        hideControls: () => { if (controlsEl) controlsEl.classList.add("mv-controls-hidden"); },
        showControls: () => { if (controlsEl) controlsEl.classList.remove("mv-controls-hidden"); },
        isControlsHidden: () => !!(controlsEl && controlsEl.classList.contains("mv-controls-hidden")),
        // Games Arrival Experiment 01 additions — analogous read-only
        // accessors for Arrival's own, entirely separate state machine.
        // getPhase()/getWorldMix()/everything above remain exactly what
        // they were in the locked v3.4 checkpoint; these are new, additive
        // surface only.
        getArrivalPhase: () => arrivalPhase, // "none" | "active" | "stable"
        getArrivalOpticalMix: () => arrivalOpticalMix, // 1 (no-op, matches entire approved Crossing) -> 0 (Arrival-stable)
        getArrivalStartedAt: () => arrivalStartedAt, // performance.now() timestamp Arrival's own clock was anchored at (T3), 0 if not yet reached
        getArrivalDuration: () => ARRIVAL_DURATION
      };
    } catch (error) {
      setStatus("fallback", `init failed: ${error.message}`);
    }
  }

  initialize();
})();
