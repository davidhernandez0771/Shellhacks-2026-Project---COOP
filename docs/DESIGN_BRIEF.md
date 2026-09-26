# COOP design brief

The single source of truth for the dashboard's look. It shares its identity with the showcase site (`site/`, rationale in `docs/DESIGN_DIRECTIONS.md`): **black, white and one orange**. The showcase is cinematic; the dashboard is a tool: calm, legible, fast.

**Vibe in one line:** an instrument panel for a camera that aims itself. The live feed and the pan gauge are the heroes; everything else is quiet.

## Tokens
All colors, type, spacing and motion live in **`web/tokens.css`**. No hard-coded colors anywhere else.

| Token | Value | Use |
|---|---|---|
| `--ink` | `#060606` | page background |
| `--ink-2` | `#0E0E0D` | panels |
| `--paper` | `#EEEDEA` | primary text, the active mode, the auto-picked target |
| `--paper-2` | `#9C9B98` | secondary text (7:1 on ink) |
| `--paper-3` | `#62615F` | ticks, disabled, never body text |
| `--lock` | `#FF5A1F` | **the one orange**: a locked target, the predicted aim, the primary action, and anything that needs you (e-stop, Arduino away, warnings) |
| `--hazard` | orange/ink stripes | the e-stop control and alert banners only |

There is no red and no green. Severity is shown with orange plus shape (hazard stripes, filled vs. outlined), never color alone.

**Type:** Archivo (display at 112–125% width for the brand and big numbers; normal width for UI text) and Martian Mono for telemetry, labels and numbers (tabular). Fonts are served from `web/fonts/`, so the Pi works offline. Sentence-case headings, no all-caps labels except detection tags (which mirror the model's class names).

**Shape:** 10px panels with a 1px line and no shadows or blur; pills for the mode switch and chips; a rectangular e-stop with a hazard edge. **Motion:** 140–240 ms ease-out; detection labels decode in (scramble) when a target is first seen; respect `prefers-reduced-motion`.

## Layout (desktop; one column on phones: feed → pan → target → lists → diagnostics)
```
┌ COOP  ● Live · 14.2 fps            [ Auto | Manual | Stop ]  [Zero here] [▨E-stop▨] ┐
├ banner (only when something needs attention: signed out, offline, e-stop, Arduino)   ┤
├───────────────────────────────────────────────┬──────────────────────────────────────┤
│                                               │ Pan: gauge (hero), ±170° limits,     │
│  LIVE FEED (4:3)                              │  needle = pan, orange mark = aim;    │
│  corner brackets + leader-line mono labels    │  Manual: ◀  Home  ▶, click the dial  │
│  (click a box = lock), velocity arrow,        │ Target: name, confidence, velocity,  │
│  predicted aim + trail                        │  lead, Lock / Clear                  │
│                                               │ In view (detections)                 │
├ diagnostics: CPU · Power · Vision · Camera ·  │ Event log                            │
│ Inference · Latency · Arduino · Uptime        │ Tuning (live settings, collapsed)    │
└───────────────────────────────────────────────┴──────────────────────────────────────┘
```

## Rules
- **The feed is sacred.** Nothing covers the center of the video except the target brackets and the prediction overlay.
- State is always visible: mode, connection (live / stale / offline / signed out), motors (live / mock / drivers off / Arduino reconnecting), e-stop.
- A locked target is orange; the auto-picked target is paper white; other detections are muted.
- Every failure has a designed state that says what happened and what to do: no camera, Arduino reconnecting, Access session expired, offline, stale, e-stop, no target. Preview them with mock data: `?demo=nocam|reconnecting|expired|offline|stale|estop|notarget|hot`.
- E-stop fires on one click (or `X`) and never waits for anything; Zero needs a second click within 3 s.
- It must work on a phone. Judges will open it on theirs.
- No build step: plain HTML, CSS and JS served by Flask, so the Pi serves it as is.
