# The math behind COOPER

How COOPER goes from YOLO boxes to a yellow or red LED. Code: `cooper/predictor.py` (the filter), `cooper/risk.py` (the rules), defaults in `cooper/config.py` (`PredictionConfig`, `RiskConfig`). Every number below is the shipped default; `cooper.example.toml` lists them all.

## 1. Why image space, relative to the camera

COOPER rides in the car, so the camera moves with you. What decides a collision is how things move **relative to the camera**, and that's exactly what the image shows: a car you're closing on grows and slides down the frame whether it's braking or you're accelerating. So there's no world map and no ego-motion estimate: everything is in frame pixels (640×480 by default), origin top-left, x to the right, y down.

Two facts about a pinhole camera looking level down a flat road (height H above it, focal length f in pixels, horizon at the image's middle row c_y) make the rest work. For an object Z metres ahead and X to the side:

$$u = c_x + f\,\frac{X}{Z}, \qquad v = c_y + f\,\frac{H}{Z}, \qquad h = f\,\frac{h_{obj}}{Z}$$

- **The bottom edge of the box is where the object touches the road** (row v). That's the point that has to be inside your lane, not the box's centre: a tall truck in the next lane can overlap your lane in the image with its roof while its wheels are nowhere near it.
- **The box height h is proportional to 1/Z.** So its growth rate tells you how fast the distance is closing without knowing the object's real size (section 5).

The OV5647 with the 3.6 mm lens is about 63° wide at 4:3, so f ≈ 320 / tan(31.5°) ≈ 522 px at 640 wide.

## 2. The Kalman filter (one per tracked object)

ByteTrack gives each object an ID; each ID gets its own constant-velocity Kalman filter.

**State and measurement**

$$\mathbf{x} = [\,u,\; v,\; h,\; \dot u,\; \dot v,\; \dot h\,]^\top \qquad \mathbf{z} = [\,u,\; v,\; h\,]^\top$$

u, v: the bottom-centre of the box (px). h: the box height (px). The dots are their rates (px/s). A box `[x1, y1, x2, y2]` measures z = [(x1 + x2)/2, y2, y2 − y1].

**Model.** With Δt the time between the two frames' capture times:

$$\mathbf{x}_k = F\,\mathbf{x}_{k-1} + \mathbf{w}, \quad F = \begin{bmatrix} I_3 & \Delta t\, I_3 \\ 0 & I_3 \end{bmatrix}, \qquad \mathbf{z}_k = H\,\mathbf{x}_k + \mathbf{n}, \quad H = \begin{bmatrix} I_3 & 0 \end{bmatrix}$$

**Process noise Q.** Each axis is a position driven by white-noise acceleration of standard deviation σ_a. Integrated over Δt that gives, per axis (position, rate):

$$Q_i = \sigma_{a,i}^2 \begin{bmatrix} \Delta t^4/4 & \Delta t^3/2 \\ \Delta t^3/2 & \Delta t^2 \end{bmatrix}$$

with σ_a = **400 px/s²** for u and v (`accel_std_px_s2`; a car 10 m away changing lanes at 3 m/s² is about 160 px/s², nearer objects more) and **150 px/s²** for h (`height_accel_std_px_s2`).

**Measurement noise R** = diag(3², 3², 3²) px² (`meas_std_px` = 3: YOLO box jitter).

**Initial state** from the first box, with zero velocity, and P₀ = diag(3², 3², 3², 300², 300², 300²): the position is as good as the measurement, the velocity is unknown to ±300 px/s (`init_vel_std_px_s`).

**Predict** (every frame):

$$\hat{\mathbf{x}}^- = F\,\hat{\mathbf{x}}, \qquad P^- = F\,P\,F^\top + Q$$

**Update** (when the measurement passes the gate, section 3):

$$\mathbf{y} = \mathbf{z} - H\hat{\mathbf{x}}^-, \quad S = H P^- H^\top + R, \quad K = P^- H^\top S^{-1}, \quad \hat{\mathbf{x}} = \hat{\mathbf{x}}^- + K\mathbf{y}, \quad P = (I - K H)\,P^-$$

**Why the code runs three tiny filters.** F, H, Q, R and P₀ are all block-diagonal per axis (u with u̇, v with v̇, h with ḣ), so P stays block-diagonal forever and the 6-state filter splits **exactly** into three independent 2-state filters. Per axis, with P = [[a, b], [b, c]], σ² the axis's acceleration variance and r = 3²:

$$\begin{aligned}
&\text{predict:} && p \mathrel{+}= \dot p\,\Delta t, \quad a' = a + 2\Delta t\,b + \Delta t^2 c + \sigma^2\Delta t^4/4, \quad b' = b + \Delta t\,c + \sigma^2\Delta t^3/2, \quad c' = c + \sigma^2\Delta t^2 \\
&\text{update:} && s = a' + r, \quad k_0 = a'/s, \quad k_1 = b'/s, \quad y = z - p, \quad p \mathrel{+}= k_0 y, \quad \dot p \mathrel{+}= k_1 y \\
& && a = (1-k_0)\,a', \quad b = (1-k_0)\,b', \quad c = c' - k_1 b'
\end{aligned}$$

That's a few dozen scalar operations per object per frame instead of 6×6 matrix products. `tests/test_predictor.py` runs the full 6×6 matrix form alongside and checks the two agree to 10⁻⁶ over 40 noisy, unevenly spaced frames.

A track that isn't seen for **0.5 s** (`lost_timeout_s`) is forgotten. A track needs **3** measurements (`min_hits`) before its velocity is trusted for warnings: one measurement has no velocity, and two can be one frame of jitter.

## 3. Occlusion: the innovation gate

When a person walks behind a nearer car, the detector only sees the part above the car's roof, so the box's bottom edge jumps up onto the roof: the "ground point" is suddenly 70 px too high and the path swings out of your lane. The fix is standard gating on the innovation. For an axis, y = z − p̂ has variance S = P⁻ + R, so a measurement with

$$y^2 > g^2\,S, \qquad g = 4 \;(\texttt{gate\_sigma})$$

is inconsistent with the track, and the filter **coasts** on its prediction instead of updating. v and h are both computed from the same bottom edge (v = y₂, h = y₂ − y₁), so they're gated **together**: if either fails, both coast. That matters because coasting widens each axis's gate (P⁻ grows with Q every frame); on its own, v's gate eventually opens wide enough to swallow the wrong bottom edge, but h's collapse (81 → 8 px in the rehearsal) stays outside its gate much longer. u (the centre, still fine) keeps updating.

If an axis keeps rejecting for **1.0 s** (`max_coast_s`), the change is real (or the tracker swapped objects) and the axis restarts on the new value.

In the rehearsal, a pedestrian hidden for 0.53 s behind a car in the next lane made the yellow LED drop out for 0.17 s without this; with it, the warning is continuous.

## 4. Predicted paths and the lane

**My lane** is a quadrilateral in normalized frame coordinates (so it survives a resolution change), corners top-left, top-right, bottom-right, bottom-left. Default:

| Corner | TL | TR | BR | BL |
|---|---|---|---|---|
| normalized | (0.44, 0.60) | (0.56, 0.60) | (0.79, 1.00) | (0.21, 1.00) |
| px at 640×480 | (281.6, 288) | (358.4, 288) | (505.6, 480) | (134.4, 480) |

It's the road right in front of the car, out to about 14 m (the top edge at y = 288 is Z = fH/(288 − 240) ≈ 522·1.3/48 m with the camera 1.3 m up). You adjust it live from the dashboard; `[risk] lane` in `cooper.toml` stores it.

**Lane test.** At row y the lane spans [x_L(y), x_R(y)], where the horizontal line crosses its edges (at y = 384 that's 208…432 px). An object's bottom edge, x₁…x₂ at row y₂, is **in the lane** when at least 20 % of it lies inside that span (`min_overlap` = 0.2):

$$\text{overlap} = \min(x_2, x_R) - \max(x_1, x_L), \qquad \text{in lane} \iff \text{overlap} > 0 \;\wedge\; \text{overlap} \ge 0.2\,(x_2 - x_1)$$

The 20 % keeps a car in the next lane whose box just touches the lane's corner from counting (12 px of a 120 px edge is 10 %: clear).

**Path.** Each object's filter is run forward at constant velocity every **0.1 s** (`step_s`) out to **1.5 s** (`horizon_s`), 15 points:

$$u(t) = \hat u + \dot{\hat u}\,t, \quad v(t) = \hat v + \dot{\hat v}\,t, \quad h(t) = \hat h + \dot{\hat h}\,t, \qquad t = 0.1, 0.2, \dots, 1.5\ \text{s}$$

The predicted box width is h(t) times the latest box's width/height ratio, and each predicted bottom edge u(t) ± w(t)/2 at row v(t) gets the same lane test. The first t that passes is the object's **time to lane**.

## 5. Time to contact from scale growth

For an object at distance Z closing at speed −Ż, h = f·h_obj/Z, so ḣ = −f·h_obj·Ż/Z² and

$$\tau = \frac{h}{\dot h} = \frac{Z}{-\dot Z}$$

the time until it reaches the camera at the current closing speed, with no need to know the object's size or distance. COOPER takes h and ḣ from the filter.

**Only when the growth is real.** Box jitter on an object that isn't moving produces small positive ḣ, and h/ḣ is then a short, false τ: in simulation, a steady 40 px box with 3 px of jitter read τ < 2 s in 20 of 50 ten-second runs. So τ counts only when ḣ is statistically distinguishable from zero, using the filter's own uncertainty σ_ḣ = √P_ḣḣ:

$$\dot h > 2\,\sigma_{\dot h} \qquad (\texttt{growth\_min\_sigma} = 2)$$

That brought false alarms to 0 of 50 runs at 1.5 px jitter and 2 of 50 at 3 px, while a real 10 m/s approach still fired every time. Boxes under **24 px** tall are ignored (`ttc_min_height_px`): a pixel of jitter is over 4 % of them.

**Only near your path.** τ counts when the object's bottom edge (with the same 20 % rule) is inside the lane's **corridor**: the lane's side edges extended past its far end towards the vanishing point, widened by 25 % of its width on each side (`lane_margin`). The extension matters because a car far ahead sits *above* the lane's top edge; without it TTC could only fire once the car was already in the lane. At y = 274 (14 px above the top edge) the corridor is 292.3…347.7 px, 278.5…361.5 with the margin.

**Hysteresis.** A TTC warning starts when τ < **2.0 s** (`ttc_warn_s`) and ends only when τ > **2.5 s** (`ttc_clear_s`), per object.

**Known bias.** At constant closing speed h accelerates (ḧ = 2ḣ²/h), which a constant-velocity filter follows with a lag, so it underestimates ḣ and τ reads late, never early: about +36 % at 10 m/s from 20 m to 10 m (true 1.0 s, estimate 1.36 s). In the rehearsal's braking scene TTC first dipped below 2.0 s when the true τ was 1.42 s; the path rule had already warned 0.5 s earlier. TTC is the backstop for things coming straight at you, where the path barely moves sideways.

## 6. From objects to LEDs

**Per object, per frame:**
- **danger**, when its current bottom edge is in the lane (`kind: "in_lane"`);
- else **warning**, when it's trusted (3+ measurements) and its predicted path enters the lane within the horizon (`"path"`), or its TTC warning is on (`"ttc"`);
- else **clear**.

**The frame's raw level** is the worst object's. Its reason is the nearest danger (largest bottom y) or the soonest warning.

**Hysteresis** turns the raw level into what the LEDs show. Per level (warning, danger): it **lights after 2 consecutive frames** at or above it (`enter_frames`) and **stays lit 0.5 s after** it was last seen (`hold_s`). The output is the highest level that's lit; danger frames count towards warning too, so red → clear goes through yellow only if the warning condition is still true. One frame of noise can't light an LED, and a detector that drops an object every third frame can't make one flicker.

**LEDs:** yellow = warning, red = danger, both off = clear. Only one is ever lit.

## 7. What it costs

Predict + risk for 10 tracked objects: **0.22 ms** median per frame (0.37 ms p99) on a laptop (Ryzen, Python 3.14). Not yet measured on the Pi 5; at 3–4× slower pure Python that's about 1 ms, a small fraction of YOLO11n's inference time.

## 8. Limits

- **Flat road, level camera.** The lane is a fixed region of the image, not detected lane lines. On a hill or a curve it no longer matches the road; recalibrate it for the mount, and treat curves as a known gap.
- **Relative motion only.** COOPER can't tell you braking from them braking. For collision risk that's the right quantity, but it knows nothing about your speed or steering.
- **Constant velocity over 1.5 s.** Sudden manoeuvres show up with a lag set by the process noise.
- **Detection limits.** Night, glare, heavy rain, and objects YOLO doesn't know (animals, debris) aren't covered: the OV5647 has no IR.
- **It's a warning light, not a safety system.** It never touches the car.
