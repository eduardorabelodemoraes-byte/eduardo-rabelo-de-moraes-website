(() => {
  "use strict";

  const SOURCE_URL = "/__ratiofix/script.js";

  async function bootApprovedCrossing() {
    const response = await fetch(SOURCE_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`Unable to load approved Crossing engine (${response.status}).`);

    let source = await response.text();

    const toleranceOriginal = "const HOME_TEXTURE_ASPECT_TOLERANCE = 0.04;";
    const tolerancePatched = "const HOME_TEXTURE_ASPECT_TOLERANCE = 0.20;";
    if (!source.includes(toleranceOriginal)) throw new Error("Approved Crossing eligibility constant was not found.");
    source = source.replace(toleranceOriginal, tolerancePatched);

    const reducedMotionOriginal = "const reduceMotion = window.matchMedia(\"(prefers-reduced-motion: reduce)\").matches;";
    const reducedMotionPatched = "const reduceMotion = false; // diagnostic preview only: force full Crossing path";
    if (!source.includes(reducedMotionOriginal)) throw new Error("Approved Crossing reduced-motion gate was not found.");
    source = source.replace(reducedMotionOriginal, reducedMotionPatched);

    const script = document.createElement("script");
    script.textContent = `${source}\n//# sourceURL=threshold-liquid-v4.1-preview.js`;
    document.head.append(script);
    script.remove();
  }

  bootApprovedCrossing().catch((error) => {
    console.error("Threshold preview bootstrap failed:", error);
  });
})();
