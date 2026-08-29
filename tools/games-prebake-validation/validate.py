#!/usr/bin/env python3
"""Phase 1B validation: quantitative comparison of generated candidates.

Read-only: only reads files under tools/games-prebake-validation/candidates/
and (for one explicitly-labeled extra comparison) the frozen checkpoint's
own preserved prebaked/ images. Writes nothing outside
tools/games-prebake-validation/validation-report.json.
"""
import hashlib
import json
import os

from PIL import Image
import numpy as np

BASE = os.path.dirname(os.path.abspath(__file__))
CANDIDATES = os.path.join(BASE, "candidates")
CHECKPOINT_PREBAKED = "/home/claude/texture-handoff-test/approved-games-arrival-2026-08-28/arrival-source/crossing-source/prebaked"


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def compare(path_a, path_b):
    hash_a, hash_b = sha256(path_a), sha256(path_b)
    if hash_a == hash_b:
        return {"byteIdentical": True, "sha256": hash_a}

    img_a = np.asarray(Image.open(path_a).convert("RGB"), dtype=np.int16)
    img_b = np.asarray(Image.open(path_b).convert("RGB"), dtype=np.int16)
    if img_a.shape != img_b.shape:
        return {"byteIdentical": False, "shapeMismatch": True,
                "shapeA": list(img_a.shape), "shapeB": list(img_b.shape)}

    diff = np.abs(img_a - img_b)
    per_pixel_max = diff.max(axis=2)
    total_pixels = per_pixel_max.size
    return {
        "byteIdentical": False,
        "shapeMismatch": False,
        "meanAbsDiff": float(diff.mean()),
        "maxAbsDiff": int(diff.max()),
        "pixelsDifferingOver5of255": int((per_pixel_max > 5).sum()),
        "pixelsDifferingOver5of255_pct": round(100 * float((per_pixel_max > 5).sum()) / total_pixels, 4),
        "pixelsDifferingAtAll": int((per_pixel_max > 0).sum()),
        "pixelsDifferingAtAll_pct": round(100 * float((per_pixel_max > 0).sum()) / total_pixels, 4),
        "totalPixels": int(total_pixels)
    }


def main():
    report = {"targets": {}}
    for key, filename in [("desktop", "mv-games-desktop.candidate.png"), ("mobile", "mv-games-iphone.candidate.png")]:
        run1 = os.path.join(CANDIDATES, "run-1", filename)
        run2 = os.path.join(CANDIDATES, "run-2", filename)
        reference = os.path.join(CANDIDATES, "reference", filename)

        entry = {
            "validationA_reproducibility_run1_vs_run2": compare(run1, run2),
            "validationB_fidelity_run1_vs_independentReference": compare(run1, reference),
        }

        # Extra, non-required, purely informational: how does today's fresh
        # candidate compare to the frozen checkpoint's own historical
        # prebaked image? NOT used as a pass/fail criterion for this task
        # (Phase 1B explicitly says historical-artwork identity is not
        # required) — reported only as additional risk-reducing context.
        checkpoint_filename = "mv-games-desktop.png" if key == "desktop" else "mv-games-iphone.png"
        checkpoint_path = os.path.join(CHECKPOINT_PREBAKED, checkpoint_filename)
        if os.path.exists(checkpoint_path):
            entry["informational_vs_frozen_checkpoint_historical_prebake"] = compare(run1, checkpoint_path)

        report["targets"][key] = entry

    out_path = os.path.join(BASE, "validation-report.json")
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))
    print("\nwrote", out_path)


if __name__ == "__main__":
    main()
