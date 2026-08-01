THE THRESHOLD IMPLEMENTATION SPECIFICATION

Engineering the transformation between worlds

The Threshold Implementation Specification translates the approved physical and phenomenological principles into an executable technical system.

It does not redefine the artistic concept.

It does not reinterpret the visitor experience.

It establishes the architecture, states, constraints, fallbacks and acceptance criteria required to implement the Home → Game Localization transition faithfully.

The implementation must remain subordinate to:

* docs/the-physics-of-the-threshold.md;
* docs/the-phenomenology-of-the-threshold.md.

Whenever a technically impressive solution conflicts with either document, the solution must be rejected.

The implementation succeeds only when its complexity disappears from perception.


I. Governing invariants

The following principles are absolute and may not be violated by implementation choices:

Nothing is destroyed. Everything is transformed.

Light follows language.

Trust always precedes wonder.

Coherence precedes complexity.

The Home remains intact and is localized into another physical reality.

The transition must never be reduced to:

* blur;
* fade;
* opacity;
* a luminous overlay;
* a geometric portal;
* a page-loading disguise;
* a conventional visual effect.

The real Home must remain structurally, semantically and functionally intact throughout the passage.

The visitor must perceive transformation, not replacement.

⸻

II. Base architecture

The full transition must use:

* temporary layered DOM;
* a viewport-limited optical reconstruction of the visible Home;
* localized SVG-based refraction;
* restrained masking and compositing;
* an independent opaque black guard;
* normal document navigation.

No new dependency should be introduced.

Canvas 2D and WebGL must not be used in this implementation phase.

The real Home

The real Home remains:

* present in the DOM;
* semantically unchanged;
* visually recognizable;
* available to assistive technologies;
* the source of all standard navigation behavior.

Its permanent HTML structure must not be modified solely to support the transition.

The optical reconstruction

When an eligible activation occurs, the implementation creates a temporary visual reconstruction of only the visible viewport.

This reconstruction must:

* align precisely with the current viewport;
* reflect the current scroll position;
* be limited to the visible region;
* be aria-hidden="true";
* be inert;
* receive no focus;
* receive no pointer events;
* contain no active IDs;
* contain no active media;
* never replace the real DOM;
* exist only for the duration of the passage.

The reconstruction is the optical surface through which the visible Home changes physical state.

It must contain the appearance of the Home itself. It must not resemble an unrelated translucent object placed above it.

Refraction

Localized SVG processing may be used to alter:

* optical displacement;
* depth;
* density;
* local coherence;
* light conduction.

The effect must remain constrained to the viewport and must not apply expensive page-wide filters to the entire document.

Black guard

The black guard is technically independent from the refractive surface.

It must not create the material.

It assumes control of the viewport only after the Home has completed its localization and the material has begun releasing its luminosity.

⸻

III. Activation contract

The Game Localization item must remain a real link:

<a href="game-localization/" data-game-localization-entry>

The transition may intercept only standard activations:

* primary mouse click;
* touch;
* keyboard activation with Enter.

The following browser behaviors must remain available:

* open in a new tab;
* open in a new window;
* copy link address;
* context menu;
* modified clicks;
* navigation without JavaScript.

Origin

For mouse or touch activation, the initial coordinates must come from the contact point.

For keyboard activation, the origin must be the geometric center of the link.

The visitor may perceive the origin of the event.

They must never perceive a geometric expansion originating from it.

The response begins at that origin, but the origin must quickly lose visual dominance.

The visitor must not perceive:

* a circle;
* an ellipse;
* a ring;
* an expanding object.

Interaction During Passage

While the transition is active:

* duplicate activations are ignored;
* temporary optical elements receive no interaction;
* focus remains outside the optical reconstruction;
* scroll may be briefly locked;
* the current scroll position remains stable;
* the real Home must not reflow;
* no focus trap may be introduced.

The implementation must restore all temporary interaction changes during cleanup, failure recovery, pagehide and pageshow.

⸻

IV. Authoritative Timeline

The transition must use one central timeline.

Only one authoritative controller may coordinate:

* refraction;
* light;
* black;
* marker creation;
* cleanup;
* navigation.

The controller must know:

* the selected execution mode;
* the starting timestamp;
* overall progress;
* the current physical state;
* whether black has been visibly painted;
* whether cleanup has occurred;
* whether navigation has been requested.

Time must feel continuous and inevitable.

The visitor must never perceive technical stages.

Movement I — Recognition

Approximate interval: 0–120 ms

The activation receives an immediate and unmistakable response.

The response is restrained, but the visitor understands that the touch changed something physical.

No large expansion or visible portal shape appears.

Movement II — Awakening

Approximate interval: 120–350 ms

The new material becomes locally perceptible.

The Home begins to lose optical rigidity.

Visible language nearest the origin responds first.

Words begin to reveal internal luminosity.

Movement III — Localization

Approximate interval: 350–900 ms

The event rapidly loses its center.

Typography conducts light into:

* editorial lines;
* spatial relationships;
* surrounding surfaces;
* the wider viewport.

The Home changes consistency and begins to obey the physics of liquid light.

Movement IV — Presence

Approximate interval: 900–1200 ms

The material reaches its clearest physical presence.

This is the moment of maximum material coherence, not maximum brightness.

The Home must remain recognizable while appearing fully composed of another substance.

Movement V — Release

Approximate interval: 1200–1450 ms

The material completes its function.

Luminosity withdraws from within the localized Home.

Nothing collapses, evaporates, fragments or disappears through destruction.

Movement VI — Silence

Approximate interval: 1450–1650 ms

Pure black is established.

Nothing moves.

No residual glow, color, texture or optical layer remains.

Movement VII — Arrival

The destination preserves the black interval for the approved combined duration.

The prologue then begins through opacity only.

The visitor must never perceive that an animation ended.

They must perceive that the transformation has reached another world.

V. Optical Material System

The transition must be implemented as a temporary optical system.

It must distinguish between:

* the real Home;
* the optical reconstruction;
* the localized material state;
* conducted light;
* the independent black guard.

These are separate engineering responsibilities.

They must never collapse into a single visual layer.

The Real Home

The Home remains the permanent document.

It is never destroyed, replaced or semantically reconstructed.

Its structure, accessibility, editorial identity and navigation remain intact.

The visitor must always be looking at the Home, either directly or through its temporary optical reconstruction.

The Material State

The material is not an object placed over the Home.

It is a temporary change in the optical state of the visible Home.

The implementation must therefore avoid representing it as:

* a growing ellipse;
* a circular mask;
* a liquid overlay;
* a translucent sheet;
* an expanding portal;
* an animated decoration.

The material must behave as a localized field of changing optical coherence.

Its visible limits remain ambiguous.

The visitor perceives presence.

They do not perceive edges.

The Optical Reconstruction

The optical reconstruction reproduces only the visible viewport.

It exists solely to permit localized optical transformation.

It must never become visually distinguishable from the real Home.

Outside the localized field, the optical reconstruction and the Home must appear identical.

Inside the field, the optical reconstruction becomes another physical state of the same page.

Appearance changes.

Identity does not.

Refraction

Refraction is the primary mechanism of transformation.

Opacity is not.

Blur is not.

Brightness is not.

Scale is not.

These properties may contribute in restrained supporting roles.

They must never define the phenomenon.

Localized refraction may alter:

* perceived depth;
* spatial continuity;
* alignment;
* density;
* optical compression;
* local expansion;
* coherence between neighboring elements.

The visitor should feel that space itself has acquired another consistency.

Language as Light

Visible language is the first conductor of luminosity.

The implementation must therefore privilege:

* glyphs;
* editorial rules;
* typographic rhythm;
* the white space surrounding language.

Light does not originate behind the page.

It appears to emerge from language itself.

Typography does not receive illumination.

Typography releases illumination.

As the field propagates, the surrounding editorial space gradually adopts the same physical condition.

Language remains the initiator of transformation.

Material Continuity

The localized field must lose its center rapidly.

After the initial response, the visitor should no longer perceive:

“the place where I clicked.”

They should perceive:

“the place that is changing.”

The transformation belongs to the world, not to the pointer.

Shape

The implementation must avoid any recognizable geometric outline.

Masks may exist internally.

Their geometry must never become visually readable.

The visitor must not perceive:

* a circle;
* an ellipse;
* a ring;
* a droplet;
* a splash;
* a wave;
* an expanding object.

Instead, the field evolves through varying optical coherence guided by:

* typography;
* editorial structure;
* density;
* open space.

Its shape is perceived through consequence rather than outline.

Material Density

Different regions may temporarily exhibit:

* stronger coherence;
* stronger refraction;
* stronger luminosity;
* deeper optical compression.

These variations must remain smooth.

They must never appear turbulent.

Nothing pulses.

Nothing vibrates.

Nothing breathes.

Nothing behaves like biological matter.

The Threshold is alive through coherence, never through imitation of organic motion.

Acceptance Criteria

During the transformation, the visitor should never be able to answer:

“What is the shape of the material?”

They should only be able to answer:

“Something physical has changed.”

If the phenomenon can easily be described as:

“a growing liquid object”

or:

“a luminous overlay”

the implementation fails.

⸻

VI. Light System

Light follows language.

The implementation must preserve this hierarchy at all times.

Light never becomes an independent actor.

It does not precede language.

It does not dominate language.

It is revealed by language and conducted through it.

Temperature

The light must remain predominantly white.

Its warmth must be restrained.

It communicates:

* welcome;
* purity;
* safety.

It must never suggest:

* electricity;
* neon;
* theatrical lighting;
* fantasy magic;
* science-fiction interfaces.

Color

No decorative palette may be introduced.

Color may exist only as a subtle consequence of:

* optical depth;
* density;
* refraction.

Visible RGB separation must never become a stylistic effect.

Chromatic behavior must remain subordinate to the perception of material.

Emission

The Home is never painted by light.

Language appears to release light from within.

This distinction is fundamental.

The visitor must never perceive illumination arriving from an external source.

They perceive luminosity emerging from the structures already present.

Release

At the completion of localization, light withdraws from within the material state.

It is not extinguished.

It is released.

The visitor should feel that the material has completed its purpose.

The transformation therefore reaches black through fulfillment, never through erasure.

Acceptance Criteria

The visitor should describe the light as:

* pure;
* living;
* calm;
* safe.

Never as:

* futuristic;
* electric;
* magical;
* decorative.

⸻

VII. Intensity, Legibility and Distortion Limits

The transformation must be unmistakable.

It must never appear destructive.

The implementation must preserve the structural identity of the Home throughout every stage of the passage.

The visitor must remain able to recognize:

* typography;
* editorial lines;
* content blocks;
* spatial relationships;
* the overall composition.

Recognition does not require optical rigidity.

The visible Home may appear to bend, compress, stretch or shift locally.

It may acquire depth, density and refractive continuity.

It must never appear:

* broken;
* melted;
* corrupted;
* unstable;
* damaged;
* unreadable;
* technically defective.

Peak Intensity

Maximum intensity occurs during Presence.

At this point:

* the material must be clearly perceptible;
* refraction must be unmistakable;
* language must appear to conduct light;
* the visible Home must seem fully localized into another physical state.

Peak intensity must reveal material coherence.

It must not erase the Home through brightness, opacity or distortion.

A frozen frame at maximum intensity must still be identifiable as the original Home.

The correct perception is:

“This is the Home, but it is now made of another material.”

Never:

“The Home has disappeared.”

“The page is breaking.”

“An effect is covering the screen.”

Typography

Letterforms must remain readable and recognizable.

The implementation may create:

* restrained optical depth;
* shallow local displacement;
* minimal stretching;
* controlled compression;
* limited diffusion around glyphs;
* altered refractive influence in nearby space.

It must not create:

* large halos;
* luminous outlines;
* neon glow;
* letter-by-letter illumination;
* typographic melting;
* aggressive warping;
* prolonged illegibility.

Language leads the transformation.

It must never become its victim.

Spatial Relationships

Refraction should affect relationships, not merely edges.

The visitor may perceive:

* altered distances;
* softened alignment;
* temporary compression;
* expanded depth;
* changed continuity between nearby elements.

These changes must remain coherent with the composition of the Home.

No element may appear to detach from the editorial system without cause.

Desktop and Mobile

Desktop may support:

* broader refractive amplitude;
* more simultaneous optical relationships;
* slightly longer material presence;
* more visible differences in depth.

Mobile must use:

* lower displacement amplitude;
* fewer simultaneous optical layers;
* more stable typography;
* stricter control of memory and effective pixel density;
* a more concentrated expression of the same physical law.

Mobile is not a simplified concept.

It is a more contained execution.

Acceptance Criteria

At peak intensity:

1. the material is immediately perceptible;
2. the Home remains recognizable;
3. typography remains legible;
4. nothing resembles damage or malfunction;
5. the transformation feels physical rather than decorative.

The transformation must become evident without becoming extreme.

⸻

VIII. Execution Modes

The Threshold must support three coherent execution modes:

1. full;
2. lightweight;
3. reduced motion.

It must also provide an essential safety fallback.

All three execution modes must express the same sequence:

language reveals light;
the Home changes state;
luminosity is released;
pure black establishes silence.

The modes may differ in technical complexity.

They may not differ in meaning.

Full Mode

Full mode is used when:

* prefers-reduced-motion is not active;
* required SVG and masking features are supported;
* the viewport and effective pixel density remain within the approved rendering budget;
* a brief capability check indicates acceptable stability.

Full mode may include:

* viewport-limited optical reconstruction;
* localized SVG displacement;
* asymmetric propagation;
* multiple restrained refractive regions;
* typography-led luminosity;
* controlled variations of optical density;
* complete temporal choreography.

Full mode must not introduce persistent rendering loops.

All optical processing ends when black becomes complete.

Lightweight Mode

Lightweight mode is used when:

* performance is uncertain;
* the viewport is constrained;
* effective pixel density is high;
* SVG processing is partially supported or expensive;
* the initial capability check indicates instability.

It preserves:

* origin at contact;
* immediate response;
* language as first conductor;
* internal luminosity;
* rapid loss of center;
* visible change of physical state;
* release into black.

It reduces:

* displacement amplitude;
* number of layers;
* mask complexity;
* density variation;
* duration of peak presence;
* expensive filter processing.

Lightweight mode must not resemble a fallback blur-and-fade.

It must feel like the same material operating within a smaller rendering budget.

Reduced Motion

Reduced motion must respect the visitor’s preference from the first visible frame.

It must avoid:

* sustained distortion;
* broad expansion;
* continuous displacement;
* intense peripheral motion;
* rapid movement across the viewport.

Its sequence should be:

1. immediate static response at the contact point;
2. restrained internal luminosity in visible language;
3. brief change in optical consistency;
4. release of light;
5. pure black;
6. destination.

Reduced motion must preserve meaning without sustained deformation.

It must not become a generic fade.

Essential Safety Fallback

If advanced initialization fails:

* the real link remains functional;
* the Home remains intact;
* the visitor is not trapped;
* navigation proceeds normally;
* the destination remains fully usable;
* no residual state remains.

A brief, stable passage to black may be used only when it can be completed safely.

If failure occurs before interception is established, normal browser navigation must continue.

Mode Selection

Mode selection must be conservative and fast.

It may consider:

* feature support;
* prefers-reduced-motion;
* viewport dimensions;
* effective pixel density;
* available device-memory signals, when present;
* a brief frame-budget check.

It must not depend primarily on:

* user-agent strings;
* model-specific device lists;
* long benchmarks;
* invasive profiling.

When uncertain, select lightweight mode.

Fluency takes precedence over visual complexity.

IX. Black Guard and Document Handoff

The black guard is part of the Threshold.

It is not a disguise for page loading.

It remains technically independent from the refractive system.

The material transforms the Home.

The black guard preserves continuity between documents.

⸻

Transition to Black

Pure black must never appear as a covering layer.

It is the final physical state reached after the release of light.

The black guard may assume the viewport only after:

1. the Home has reached complete localization;
2. material presence has stabilized;
3. luminosity has begun to release from within.

There must be no:

* gray wash;
* white flash;
* transparent interval;
* browser-default background;
* residual color;
* residual glow;
* reappearance of the Home.

⸻

Painted-Black Confirmation

Navigation may begin only after pure black has been visibly painted for at least one or two fully presented frames.

Only then may the implementation:

* record the entry marker;
* remove temporary optical resources;
* initiate document navigation.

The visitor must never perceive cleanup occurring.

⸻

Entry Marker

The existing sessionStorage handoff may be preserved.

The marker must include:

* version;
* source;
* timestamp at which pure black was confirmed;
* selected execution mode.

The marker must be:

* optional;
* short-lived;
* removed immediately after reading;
* rejected when invalid;
* rejected when expired;
* incapable of blocking direct access or refresh.

The marker coordinates silence.

It does not enable the destination.

⸻

Combined Black Interval

The approved initial targets are:

* Full Mode: approximately 650–850 ms;
* Lightweight Mode: approximately 500–700 ms;
* Reduced Motion: approximately 250–350 ms.

The interval includes:

* black already presented on the Home;
* document navigation;
* destination loading;
* remaining silence before the prologue.

If loading already exceeds the required silence, the destination may begin immediately.

Artificial delay must never be added after the required silence has already elapsed.

⸻

Destination

The destination preserves:

* critical inline black on html and body;
* color-scheme: dark;
* semantic HTML;
* direct access;
* refresh;
* independence from the entry marker.

The prologue begins through opacity only.

No translation.

No typing effect.

No slide.

No glow.

⸻

Acceptance Criteria

Frame-by-frame inspection must never reveal the technical boundary between documents.

The visitor perceives only:

transformation → release → black → language

Never:

effect → loading → new page

Never:

rendering → handoff → destination

⸻

X. Performance and Rendering Budget

The implementation may be visually rich.

It must remain technically silent.

⸻

Viewport Limitation

All temporary optical work must remain limited to the visible viewport.

The implementation must not:

* reconstruct the full document height;
* create surfaces substantially larger than the visible viewport;
* apply expensive filters to the entire page;
* preserve off-screen optical content;
* retain temporary layers after black is complete.

⸻

Effective Pixel Density

The optical reconstruction should remain within a validated rendering budget.

Typical implementations are expected to operate effectively between approximately 1.5× and 2× effective pixel density.

Native device DPR must not automatically determine reconstruction resolution.

⸻

Preferred Operations

Prefer:

* transform;
* opacity;
* localized compositing;
* viewport-limited masks;
* restrained SVG displacement;
* a small number of composited layers;
* one authoritative controller;
* batched layout reads and writes.

Avoid:

* page-wide animated blur;
* continuously animated complex feTurbulence;
* repeated reconstruction;
* alternating layout measurement and mutation;
* permanent will-change;
* multiple animation loops;
* oversized off-screen surfaces;
* unnecessary chromatic processing.

⸻

Immediate Response

The visitor must receive visible feedback without perceptible delay.

Capability detection must therefore:

* remain brief;
* complete before expensive initialization;
* never delay the first response;
* select a safer execution mode whenever uncertainty exists.

No capability check may become perceptible.

No transition may begin with a visibly frozen frame.

⸻

Lifecycle

The implementation must safely handle:

* pagehide;
* pageshow;
* BFCache restoration;
* visibility changes;
* repeated activation;
* Escape;
* filter initialization failure;
* optical reconstruction failure;
* delayed navigation;
* partial cleanup.

Interrupted execution must resolve in only one of two ways:

1. complete safely into black and navigate;
2. restore the Home completely.

No intermediate optical state may remain visible.

⸻

Resource Cleanup

Once black has been confirmed, the implementation must:

* cancel requestAnimationFrame;
* cancel Web Animations;
* clear timers;
* remove temporary listeners;
* remove the optical reconstruction;
* remove temporary SVG filters and masks;
* remove temporary black layers;
* clear custom properties;
* release object references;
* restore interaction state;
* preserve defensive cleanup for pagehide;
* reset correctly during pageshow.

No rendering activity may continue after navigation begins.

⸻

Acceptance Criteria

On supported devices:

* the first response is immediate;
* no visible startup stall occurs;
* no major frame drop interrupts continuity;
* no background processing survives navigation;
* browser back restores a pristine Home;
* no temporary layer remains;
* no scroll position is lost;
* no layout shift occurs.

The implementation must feel:

physically rich, technically silent.

⸻

XI. Accessibility and Interaction Safety

The Threshold may be immersive.

It must never reduce autonomy.

⸻

Real Link

The Game Localization entry remains a real hyperlink.

Standard browser behavior remains intact.

The transition may intercept only eligible standard activation.

⸻

Temporary Optical Elements

Every temporary optical element must be:

* aria-hidden="true";
* inert where supported;
* unfocusable;
* free of active IDs;
* permanently excluded from pointer interaction;
* excluded from accessible naming;
* removed before navigation.

The optical reconstruction must never duplicate semantic content for assistive technologies.

⸻

Focus

The implementation must not:

* move focus into temporary optical content;
* trap focus;
* discard existing focus without necessity;
* introduce invisible focusable elements.

The destination remains naturally navigable.

⸻

Scroll

Scroll may be temporarily locked.

The implementation must:

* preserve position;
* avoid layout shift;
* avoid scroll trapping;
* restore every temporary scroll-related property.

The destination scrolls normally.

⸻

Escape

Escape remains a safe acceleration mechanism.

When pressed during the transformation, it should:

1. complete immediately into black;
2. clean temporary optical resources;
3. record a valid entry marker;
4. navigate.

Escape does not reverse the transformation.

It simply accelerates its completion.

⸻

Reduced Motion

Reduced Motion must be selected before sustained deformation begins.

The conceptual sequence remains unchanged.

The visitor still experiences:

* recognition;
* luminosity;
* restrained material presence;
* release;
* black;
* arrival.

⸻

Partial JavaScript Failure

The destination must be hardened against the known partial-failure condition.

If inline initialization creates a JavaScript-dependent hidden state but external initialization fails, opening language must automatically become visible after a brief independent fail-safe.

The remainder of the narrative must always exist in semantic HTML.

⸻

Required Test Scenarios

The implementation must be validated using:

* mouse;
* touch;
* keyboard;
* Enter;
* Escape;
* modified click;
* new tab;
* context menu;
* JavaScript disabled;
* unavailable sessionStorage;
* Reduced Motion;
* direct access;
* refresh;
* browser back;
* BFCache restoration;
* external initialization failure.

In every case, the visitor must never:

* lose content;
* become trapped;
* encounter invisible essential language;
* leave the Home in a damaged state.

Safety must exist both as perception and as actual behavior.

⸻

XII. Failure Recovery and Final Cleanup

Failure recovery is not a different experience.

It is another way of preserving trust.

⸻

Before Interception

If initialization fails before preventDefault() executes, the browser follows the real link normally.

⸻

After Interception

If initialization fails after interception but before visible transformation begins, the implementation must either:

* restore the Home completely and continue normal navigation; or
* establish black immediately and navigate.

The chosen behavior must remain deterministic.

⸻

During Transformation

If runtime failure occurs after visible transformation has begun:

* do not freeze;
* do not expose a broken optical reconstruction;
* do not expose partial masks;
* do not attempt complex reversal.

Complete safely into black.

Clean temporary resources.

Navigate.

⸻

During Black

Once black has been confirmed:

* no optical recovery is required;
* cleanup proceeds;
* navigation continues;
* the destination assumes responsibility for the remaining silence.

⸻

Back Navigation

During pageshow, especially after BFCache restoration, the Home must be restored to a pristine state.

The reset removes:

* transition classes;
* custom properties;
* optical layers;
* black guards;
* interaction locks;
* temporary listeners;
* navigation flags.

The restored Home behaves as though no transformation had previously occurred.

⸻

Final Technical Principle

Success and failure must tell the same story.

Even under degraded conditions:

* nothing appears destroyed;
* the visitor remains safe;
* the real link remains authoritative;
* the destination remains accessible;
* the Home remains recoverable without residue.

The implementation is complete only when failure also respects the laws of the Threshold.
