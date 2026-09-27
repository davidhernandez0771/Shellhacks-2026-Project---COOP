# COOPER: setting up at the venue (laptop)

Everything is on GitHub. Nothing is left only on the desktop.
Repo: https://github.com/davidhernandez0771/Shellhacks-2026-Project---COOPER

**Live links**
- Main site (the `dev` branch): https://coop.davidhernandez.work
- Design previews (update on every push):
  - https://design-showcase-v2.coop-224.pages.dev
  - https://design-fx.coop-224.pages.dev
  - https://design-sims.coop-224.pages.dev

---

## 1. Install (skip anything the laptop already has)
1. **Git**: https://git-scm.com/download/win
2. **Python 3.13**: python.org → Downloads → Windows → "Windows installer (64-bit)". **Tick "Add python.exe to PATH".**
3. **VS Code**, plus **Claude Code** (log in with your Claude account).
4. Close and reopen the terminal afterwards so it sees Python and Git.

## 2. Get the project (PowerShell, one line at a time)
```
git clone https://github.com/davidhernandez0771/Shellhacks-2026-Project---COOPER C:\dev\COOP
cd C:\dev\COOP
git switch dev
pip install -r requirements.txt
python -m pytest -q
```
`pytest` should end with every test passed and none skipped. The install takes a few minutes (PyTorch is big).

Then create one folder per design lane (each is its own branch, so terminals can't collide):
```
git worktree add C:\dev\COOP-site design/showcase-v2
git worktree add C:\dev\COOP-fx design/fx
git worktree add C:\dev\COOP-sims design/sims
```

## 3. Every time you sit down (on any computer)
Run `git pull` in each folder you'll use:
```
cd C:\dev\COOP;      git pull
cd C:\dev\COOP-site; git pull
cd C:\dev\COOP-fx;   git pull
cd C:\dev\COOP-sims; git pull
```
**Before switching computers, make sure each terminal has pushed**, or the other computer won't see the work.

---

## 4. The terminals
In VS Code, open a new terminal for each one. `cd` into its folder, run `claude`, type `/model` and pick the model shown, then paste its prompt.

### Coordinator: `C:\dev\COOP` · Opus 5.5
Merges each lane after you approve its preview, and keeps an eye on everything.
```
You are the coordinator for COOPER. Read CLAUDE.md, docs/TERMINALS.md and docs/SHOWCASE_V2_PLAN.md (on branch design/showcase-v2: git fetch, then git show origin/design/showcase-v2:docs/SHOWCASE_V2_PLAN.md). Three design lanes work in separate worktrees: C:\dev\COOP-site (design/showcase-v2, the integration branch), C:\dev\COOP-fx (design/fx) and C:\dev\COOP-sims (design/sims). When I say a lane is approved, merge it into design/showcase-v2, resolve conflicts carefully, check the site in the browser (no console errors, 1440 and 390 px), and push. When I approve the whole redesign, merge design/showcase-v2 into dev, run pytest, and push, which makes it live on coop.davidhernandez.work. Never push to main. Confirm with me before every merge.
```

### Lane A (Type & wordmark): `C:\dev\COOP-site` · Opus 5.5
```
Read CLAUDE.md and docs/SHOWCASE_V2_PLAN.md. You are Lane A (Type & wordmark): steps 1, 2, 3 and 7 and your lane's OriginKit components, only in your lane's files. The OriginKit code I copy is saved in C:\dev\COOP-site\site\_originkit\. I'm here: show me each step in the browser and wait for my OK. Start with step 1 (Diego Avila), then the font specimen page. Use the frontend-design and brainstorming skills. Review each step 3 times (correctness, retest in the browser, art-director critique) before showing me. Push to your branch after each approved step, never to dev or main.
```

### Lane B (Cursor & extras): `C:\dev\COOP-fx` · Sonnet 5
```
Read CLAUDE.md and docs/SHOWCASE_V2_PLAN.md. You are Lane B (Cursor & extras): steps 4 and 6 and your lane's OriginKit components (Particle Gimbal loader, Scan Grid and Tactile buttons, Neon/Glow Border, Pixel Trail), only in your lane's files. The OriginKit code I copy is saved in C:\dev\COOP-site\site\_originkit\ (read it from that path). Start with the target cursor and show it to me in the browser before doing the rest, one piece at a time. Use the frontend-design skill. Use tokens.css variables for all fonts and colors (Lane A is changing the font). Review each piece 3 times (correctness, retest in the browser, art-director critique) before showing me. Push to your branch after each approved piece, never to dev or main.
```

### Lane C (Simulations): `C:\dev\COOP-sims` · Opus 5.5
```
Read CLAUDE.md and docs/SHOWCASE_V2_PLAN.md. You are Lane C (Simulations): step 5 and your lane's OriginKit components (Predictive Arc, Dither Reveal, Morphing Glyph Cloud, and ASCII Wave only as an optional prototype), only in your lane's files; never touch js/stage/carousel.js. The OriginKit code I copy is saved in C:\dev\COOP-site\site\_originkit\ (read it from that path). Start with the 1-bit dither look on one chapter and show it to me in the browser before converting the rest, then the iris reveal, then the interactive PREDICT drag. Use the frontend-design and brainstorming skills. Keep 60 fps and the fallbacks. Review each piece 3 times (correctness, retest in the browser, art-director critique) before showing me. Push to your branch after each approved piece, never to dev or main.
```

### Hardware: `C:\dev\COOP` · Sonnet 5 (switch to Opus if stuck)
Use this once the parts are on the desk. It can share the coordinator's folder, but use a separate terminal.
```
Read CLAUDE.md and docs/HARDWARE_TEST.md. Today we bring up the real hardware (Pi 5, OV5647 camera, the yellow and red LEDs, mounted in the car). Walk me through the checklist one step at a time, starting with the laptop rehearsal (python -m tools.rehearsal --timeline), then the camera, the LEDs, the lane calibration and the parked risk test. Wait for me to report each result before moving on, and fix anything that fails. Work on dev, commit small, and tell me before pushing.
```

**If usage runs low:** pause Lane B first (its extras are the least essential), then Lane A. Keep Lane C and Hardware.

---

## 5. OriginKit components (you do this part)
1. Sign in at https://www.originkit.dev (the free plan allows **10 copies a day**).
2. Open each component and set its colors to ours: background `#060606`, text off-white, accent orange.
3. Click **Get this Component**, copy the code, and save it as **`C:\dev\COOP-site\site\_originkit\<name>.txt`** (e.g. `vector-wordmark.txt`). That folder is git-ignored, so the raw code never gets published.
4. Tell that lane's terminal the file is there.

**Today's 10, in order** (the lane is in brackets):
1. Vector Wordmark (A)
2. Particle Gimbal (B, the loader)
3. Dither Reveal (C)
4. Mask Text Reveal (A)
5. Scan Grid Button (B)
6. Tactile Button (B)
7. Neon Border (B)
8. Predictive Arc (C)
9. Morphing Glyph Cloud (C)
10. Interactive Grid (A)

**Tomorrow:** Pixel Trail, Outline Typeflow, Glow Border, and ASCII Wave (only if you like its prototype).

---

## 6. Useful commands
| What | Command (from `C:\dev\COOP`) |
|---|---|
| Tests | `python -m pytest -q` |
| The whole app with no hardware (a synthetic road, mocked LEDs) | `python -m tools.rehearsal`, then open http://localhost:8000 |
| App with the laptop webcam | `python -m cooper.main --source webcam` |
| Preview a design lane locally | `python -m http.server 8124 --directory C:\dev\COOP-site\site`, then open http://localhost:8124 |

## 7. Reminders
- The team is **David Hernandez** (software) and **Diego Avila** (design and hardware).
- Still to decide: Diego's GitHub or LinkedIn link, and whether David's team card links SANT (https://github.com/davidhernandez0771/Nebius-X-NVIDIA-Hackathon-Project).
- The hardware checklist is `docs/HARDWARE_TEST.md`; the Devpost copy is `docs/DEVPOST.md`.
- Only merge to `main` once the hardware checklist passes.
