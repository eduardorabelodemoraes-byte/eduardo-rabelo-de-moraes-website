# Launch Crossing Policy

Status: APPROVED FOR FINAL INTEGRATION

## Frozen experience

The approved Home → Game Localization experience is Candidate A4 at commit:

`314898253ffac2420f5d87fa73b50968202de667`

A4 itself is frozen and must not be modified.

## Production behavior

For the public website:

- Clicking the linked **Game Localization** heading in the Home **Expertise** section should trigger the approved A4 Crossing automatically.
- No `?thresholdIntegration=1` query parameter should be required from visitors.
- Direct visits to `/game-localization/` should remain direct and should not replay the Home Crossing.
- The plain-text `Game Localization` mention in the Hero expertise list remains non-interactive unless a later site-wide link policy explicitly changes it.
- Existing Return/Back behavior from the Game Localization page should remain unchanged.
- Browser Back behavior should retain the A4 re-entry handling already validated.

## Preservation rule

Production activation must be implemented outside the frozen A4 artifact with the smallest possible adapter-level change. Do not change C400, shaders, physics, Crossing v3.4 choreography, Arrival 01, timings, canonical Home captures, or prewarm architecture.

## Validation rule

After production activation is implemented on a launch branch, perform only one smoke test on desktop and one on iPhone before merging to `main`.
