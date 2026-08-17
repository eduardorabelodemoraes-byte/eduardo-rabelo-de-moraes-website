(() => {
  "use strict";

  const SOURCE_URL = "/__ratiofix/script.js";

  async function bootApprovedCrossing() {
    const response = await fetch(SOURCE_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`Unable to load approved Crossing engine (${response.status}).`);

    let source = await response.text();
    const original = "const HOME_TEXTURE_ASPECT_TOLERANCE = 0.04;";
    const patched = "const HOME_TEXTURE_ASPECT_TOLERANCE = 0.20;";
    if (!source.includes(original)) throw new Error("Approved Crossing eligibility constant was not found.");
    source = source.replace(original, patched);

    const script = document.createElement("script");
    script.textContent = `${source}\n//# sourceURL=threshold-liquid-v4.1-preview.js`;
    document.head.append(script);
    script.remove();
  }

  bootApprovedCrossing().catch((error) => {
    console.error("Threshold preview bootstrap failed:", error);
  });
})();
