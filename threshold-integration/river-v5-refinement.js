// experiment/river-crossing-openai-v5
// Narrow visual refinement only: keep the v4 click-origin Home capture and
// material front untouched, but re-center the portal's liquid energy when the
// Crossing enters its reveal phase. This does not alter material-engine.js,
// its shader math, or its timing constants.
(() => {
  "use strict";

  let fired = false;

  function pulseCenter() {
    if (fired) return;
    const crossing = window.__mvCrossing;
    const canvas = document.getElementById("mv-canvas");
    if (!crossing || !canvas) return;

    const phase = crossing.getPhase?.();
    const stage = crossing.getRevealSubStage?.();
    if (phase !== "revealing" && stage !== "recognition") return;

    fired = true;
    const x = window.innerWidth * 0.5;
    const y = window.innerHeight * 0.47;

    // A single central impulse lets the approved liquid field form the portal
    // around the middle of the viewport rather than inheriting all of its
    // visible energy from the original Game Localization click position.
    canvas.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y
    }));
  }

  function tick() {
    pulseCenter();
    if (!fired) requestAnimationFrame(tick);
  }

  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      fired = false;
      requestAnimationFrame(tick);
    }
  });

  requestAnimationFrame(tick);
})();
