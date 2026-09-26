# Models

The 3D camera in the Warn, Build and Team chapters is a **placeholder**: a procedural camera head on a turning base, with an exploded view of solids left over from the old pan-tilt design. The real COOPER is a fixed dashcam and nothing on it moves.

To replace it, drop a model of the real unit here as `cooper-camera.glb`, then set `CAMERA_MODEL_URL` in `js/stage/solids.js`. Requirements (facing −Z, +Y up, origin at the centre of the base, metres) are in `site/README.md`.

Until then the site uses the placeholder, so this folder can stay empty.
