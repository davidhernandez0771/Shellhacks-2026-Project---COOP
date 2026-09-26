# COOP design brief

The single source of truth for the dashboard's look. Its style comes from the team's previous project (SANT): clean, Apple-style restraint; dark, warm, glassy; one accent color; calm motion. COOP applies that to a **live camera console**.

**Vibe in one line:** a calm, premium control room. The live feed is the hero, and everything else is quiet glass around it.

## Tokens
All colors, radii, spacing and motion live in **`web/tokens.css`**. No hard-coded colors anywhere else.

| Token | Value | Use |
|---|---|---|
| `--bg-0` | `#0B0807` | page background |
| `--bg-glow` | `#2A130A` | warm radial glow, top-left and bottom |
| `--surface` | `rgba(255,255,255,0.045)` | glass cards |
| `--surface-border` | `rgba(255,255,255,0.09)` | 1px card outline |
| `--text` | `#F4F0EC` | primary text |
| `--text-muted` | `#8E837B` | secondary text |
| `--accent` | `#35F0D0` | **the one accent**: live, active mode, locked target, primary buttons |
| `--warm` | `#FF9A2E` | meters, "searching", warnings, mock motors |
| `--danger` | `#FF5A5F` | stop, disconnected, errors |

Shape: cards 24–28px radius with `backdrop-filter: blur(20px)`, a 1px border, a soft inner top highlight and no hard shadows. Pills for status chips. Meters are rows of dots, not bars. Type: the system sans stack; large light headings; small muted sublines; **tabular numbers** for angles and fps; a small monospace for telemetry labels. Motion: 150–350ms ease-out; respect `prefers-reduced-motion`.

## Layout (desktop; stacks vertically on phones)
```
┌ top bar ────────────────────────────────────────────────────────────┐
│ COOP (wordmark)     [● LIVE · 14 fps]      [ Auto | Manual | Stop ] │
├──────────────────────────────────────────────┬──────────────────────┤
│                                              │ Target card          │
│  LIVE FEED (hero, glass frame, 4:3)          │  label #id, dot-meter│
│  • overlay boxes drawn client-side from      │  velocity, lock/clear│
│    /api/status so they're clickable (click a │ Gimbal card          │
│    box = lock that target)                   │  pan dial (arc gauge)│
│                                              │  with limits + target│
│  manual mode: D-pad + home under the feed    │ Detections card      │
│                                              │ Event log card       │
└──────────────────────────────────────────────┴──────────────────────┘
```

## Rules
- **The feed is sacred.** Nothing covers the center of the video except the target reticle.
- State is always visible: mode, connection (live/stale), and motors (live / mock / disconnected).
- A locked target uses the accent; an auto-picked target uses a softer accent outline; other detections are muted white.
- It must work on a phone. Judges will open it on theirs.
- No build step: plain HTML, CSS and JS served by Flask, so the Pi serves it as is.
