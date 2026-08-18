(() => {
  "use strict";

  const SOURCE_URL = "/__ratiofix/script.js";

  window.__thresholdDiagnostic = (stage, detail = "") => {
    let panel = document.getElementById("threshold-diagnostic");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "threshold-diagnostic";
      Object.assign(panel.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        background: "#080b14",
        color: "#f4f1ea",
        padding: "max(32px, env(safe-area-inset-top)) 24px 32px",
        font: "16px/1.5 system-ui, -apple-system, sans-serif",
        overflow: "auto",
        whiteSpace: "pre-wrap"
      });
      document.body.append(panel);
    }
    panel.textContent = `THRESHOLD DIAGNOSTIC\n\n${stage}\n\n${detail}`;
  };

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

    const homeFallbackOriginal = `    if (!homeReference) {\n      running = false;\n      window.location.assign(destination.href);\n      return;\n    }`;
    const homeFallbackPatched = `    if (!homeReference) {\n      running = false;\n      window.__thresholdDiagnostic(\"HOME_TEXTURE_REJECTED\", \"viewport=\" + window.innerWidth + \"x\" + window.innerHeight + \" aspect=\" + (window.innerWidth / Math.max(window.innerHeight, 1)).toFixed(4));\n      return;\n    }`;
    if (!source.includes(homeFallbackOriginal)) throw new Error("Approved Crossing home-texture fallback block was not found.");
    source = source.replace(homeFallbackOriginal, homeFallbackPatched);

    const setupFallbackOriginal = `    } catch (error) {\n      console.warn(\"Threshold crossing fallback:\", error);\n      canvas.remove();\n      root.classList.remove(\"threshold-running\");\n      running = false;\n      window.location.assign(destination.href);\n      return;\n    }`;
    const setupFallbackPatched = `    } catch (error) {\n      console.warn(\"Threshold crossing fallback:\", error);\n      canvas.remove();\n      root.classList.remove(\"threshold-running\");\n      running = false;\n      window.__thresholdDiagnostic(\"CROSSING_SETUP_FAILED\", error && error.stack ? error.stack : String(error));\n      return;\n    }`;
    if (!source.includes(setupFallbackOriginal)) throw new Error("Approved Crossing setup-fallback block was not found.");
    source = source.replace(setupFallbackOriginal, setupFallbackPatched);

    const script = document.createElement("script");
    script.textContent = `${source}\n//# sourceURL=threshold-liquid-v4.1-preview.js`;
    document.head.append(script);
    script.remove();
  }

  bootApprovedCrossing().catch((error) => {
    console.error("Threshold preview bootstrap failed:", error);
    window.__thresholdDiagnostic("BOOTSTRAP_FAILED", error && error.stack ? error.stack : String(error));
  });
})();
