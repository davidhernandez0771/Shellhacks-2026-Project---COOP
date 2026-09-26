# Showcase design directions (2026-09-26, unattended brainstorm)

Written by the overnight cloud session following the `brainstorming` skill in **unattended mode**: the questions were answered from `docs/CLOUD_PLAN.md`, three directions were written down, and one was picked. David can overrule the pick in the morning; everything below the decision is implementation detail.

## What the brief fixes (not up for debate)
- Black, white and orange only. Near-black stage, off-white text, one orange.
- A display face with character, a clean sans for body text, a mono for labels and telemetry.
- One persistent WebGL scene behind the page, driven by scroll and pointer; loader + enter gesture; the "COOP" scrambleText intro; seven chapters (SEE, DETECT, PREDICT, MOVE, BUILD, GALLERY, TEAM).
- 60 fps, light initial load, reduced-motion and no-WebGL versions, phones.

Those constraints already put the site into two of the "generated-design" clusters the `frontend-design` skill warns about (a near-black stage with one bright accent, and a mono face for small labels). Because the brief asks for them, they stay. So the identity has to come from somewhere else: **the subject matter itself**. COOP is a machine that turns a pixel into an angle and then turns itself by that angle. The thing it thinks in is *bearing*.

## Answers to the brainstorming questions (self-answered)
- **Who is it for?** ShellHacks judges, first on a laptop at the expo table, then on their phones later. Secondary: recruiters and the team's portfolio.
- **What must a visitor remember?** That this camera *predicts* and then physically *turns*. The math is real (world angles, Kalman lead aim), and the hardware is real.
- **What does success look like?** A judge scrolls the whole thing in ~60 seconds, understands the pipeline without reading paragraphs, and says "that looks like a product launch".
- **Where's the risk?** Generic particle-sphere WebGL; too much text; performance on a judge's mid-range laptop.

## Direction A: "Bearing" (instrument) ← picked
The page *is* the camera's point of view, and scrolling *is* panning. A heading tape runs along the bottom edge like an avionics bearing scale; as you scroll, the virtual COOP turns, the tape slides, and a readout shows the real pan angle in degrees. Every chapter sits "at" a bearing. Overlays use the language of the actual dashboard: corner-bracket reticles, thin leader lines, tiny labels (`PERSON #3 · CONF 0.87`). Orange is used for exactly one meaning: **lock** (the tracked target, the aim point, the active chapter, the primary action). Everything else is white at different strengths.
- **Type:** Archivo at its widest (wdth 125, heavy) for display: extended grotesks are the language of camera and optics brands, and its wide O's read as lenses in "COOP". Archivo at normal width for body text (same family, clearly distinct by width). Martian Mono, a squared mono, for telemetry. STIX Two for the equation figure only (math is set in a serif italic by convention).
- **Why it's specific:** the signature element (a bearing tape that moves with scroll) is literally how the product works (world-angle space); it couldn't be moved onto another project's site without becoming meaningless.
- **Risk:** instrument chrome can clutter. Mitigation: one tape, one reticle cursor, and nothing else permanent on screen except the pill nav.

## Direction B: "Night shift" (surveillance dossier)
A CCTV archive: timestamped frames, film-strip gallery, redaction bars, case-file typography, scanlines and noise.
- **For:** strong mood, easy to understand ("security camera").
- **Against:** the CCTV look is a cliché, and it frames the project as surveillance of people, which is the least flattering reading of a person-tracking camera. Scanlines and noise also fight the "soft blooms on black" feel the brief asks for.

## Direction C: "Signal from noise" (generative)
Pure generative art: a huge particle field that organises itself into meaning chapter by chapter, with giant type and almost no UI.
- **For:** the closest to Active Theory's surface, and very cinematic.
- **Against:** it's the default WebGL showcase (particles morphing between shapes); without an idea tying the motion to the product it reads as a template. It also hides the engineering, which is the project's real strength.

## Decision
**A, "Bearing"**, borrowing C's particle street scene for chapters 01–03 (the brief asks for point clouds), because the particles then have a job: they are what the camera sees, and the overlays are what it understands.

## Token plan
| Token | Value | Role |
|---|---|---|
| `--ink` | `#060606` | stage (true near-black, no warm or blue tint) |
| `--paper` | `#EEEDEA` | primary text, strong lines |
| `--paper-2` | paper at 64% | secondary text (≥ 7:1 on ink) |
| `--paper-3` | paper at 40% | tertiary / tick marks, never body text |
| `--lock` | `#FF5A1F` | the one orange: lock, aim, active, primary action |
| `--lock-dim` | lock at 18% | orange washes (focus rings, fills) |

Type scale (1.333, perfect fourth, from 16 px body): 12 / 16 / 21 / 28 / 38 / 50 / 67, with the display set fluid up to ~22vw for "COOP".

Layout: left-aligned copy in a narrow column (≤ 34 ch for leads, ≤ 62 ch for body) against the full-bleed stage; the stage's subject sits right of center on desktop and behind the copy on phones (with a scrim). Chapter numbers are real sequence (the pipeline runs in that order), so numbering is justified here.

```
┌───────────── ( COOP  see detect predict move build gallery team  GitHub ) ─────────────┐
│                                                                                        │
│  02                                                   ┌─┐          ┌──┐                │
│  Detect                                               │ │ PERSON #3│  │                │
│  Boxes snap onto what matters…                        └─┘ CONF .87 └──┘                │
│                                                                                        │
│ 03 / 07   ·|·····|·····|··· 330 ···|·····|····· N ·····|·····   PAN +012.4°            │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

## Principles
1. Orange means lock. If something is orange, it's the thing COOP (or you) has chosen.
2. The overlays are the product's own UI language, so the showcase and the dashboard feel like one system.
3. One orchestrated moment per chapter, scrubbed by scroll, not a dozen fade-ins.
4. Real content only: no invented metrics, quotes or people. Placeholders are marked `✏️ PLACEHOLDER`.

## Self-review against the brief
- *Would I have produced this for any "AI camera" site?* The particle street and reticle boxes, maybe; the bearing tape tied to scroll, the orange-means-lock rule and the extended-grotesk "lens" wordmark, no. Kept.
- *First draft used Space Grotesk + JetBrains Mono.* Both are the reflex choices for "tech" pages; swapped for Archivo (extended) + Martian Mono.
- *First draft had a glassmorphism card per chapter.* That's the SaaS-card kit; removed. Copy sits directly on the stage with a gradient scrim for legibility.
