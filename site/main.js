// COOP showcase entry. Loads in stages behind the gate so the first paint is tiny:
// fonts → anime.js → three.js + the scene → enter → intro.

import { createGate } from "./js/gate.js";

const root = document.documentElement;
const still = root.classList.contains("still");
const webgl = !root.classList.contains("no-webgl");

// Placeholder links still pointing at "#": inert, not a jump to the top.
document.querySelectorAll('a[data-placeholder][href="#"]').forEach((a) => {
  a.setAttribute("aria-disabled", "true");
  a.title = "Coming soon";
  a.addEventListener("click", (e) => e.preventDefault());
});

// Team Discord handles: click to copy (Discord has no public profile URL to link to).
const copyStatus = document.getElementById("team-copy-status");
document.querySelectorAll(".team-link-discord[data-discord]").forEach((btn) => {
  let resetTimer = 0;
  btn.addEventListener("click", async () => {
    const handle = btn.dataset.discord;
    try {
      await navigator.clipboard.writeText(handle);
    } catch (e) {
      // clipboard API unavailable (insecure context, permissions): the handle is still visible as text
    }
    btn.classList.add("is-copied");
    if (copyStatus) copyStatus.textContent = `Copied ${handle} to the clipboard`;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => btn.classList.remove("is-copied"), 1600);
  });
});

// Hero CTAs: progressively enhance the two plain links with their press/hover mechanics.
Promise.all([import("./js/fx/tactile-button.js"), import("./js/fx/scan-grid-button.js")]).then(([tactile, scangrid]) => {
  const how = document.getElementById("cta-how");
  const gh = document.getElementById("cta-github");
  if (how) tactile.createTactileButton(how, { reducedMotion: still });
  if (gh) scangrid.createScanGridButton(gh, { reducedMotion: still });
});

// Section headings: mask-reveal on first scroll into view.
import("./js/fx/mask-text-reveal.js").then(({ initMaskTextReveal }) => {
  initMaskTextReveal(document.querySelectorAll(".ch-title"), { reducedMotion: still });
});

// Heavier WebGL/canvas fx: lazy-mount once their host nears the viewport, skipped entirely
// without WebGL (their hosts are all display:none under html.no-webgl, see styles.css).
function lazyMount(hostId, load, mount) {
  const host = document.getElementById(hostId);
  if (!host) return;
  if (!("IntersectionObserver" in window)) { load().then((mod) => mount(mod, host)); return; }
  const io = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) return;
    io.disconnect();
    load().then((mod) => mount(mod, host));
  }, { rootMargin: "600px 0px" });
  io.observe(host);
}

if (webgl) {
  lazyMount("predict-bg", () => import("./js/fx/predictive-arc.js"), (mod, host) =>
    mod.createPredictiveArc(host, { reducedMotion: still }));
  lazyMount("pipeline-dither", () => import("./js/fx/dither-reveal.js"), (mod, host) =>
    mod.createDitherReveal(host, { src: "media/pipeline.svg", reducedMotion: still }));
  lazyMount("leds", () => import("./js/fx/neon-border.js"), (mod, host) =>
    mod.createNeonBorder(host, { reducedMotion: still }));

  const STACK_ITEMS = [
    { name: "Python", src: "media/logos/python.svg" },
    { name: "Raspberry Pi", src: "media/logos/raspberry-pi.svg" },
    { name: "YOLO / Ultralytics", src: "media/logos/yolo.svg" },
    { name: "PyTorch", src: "media/logos/pytorch.svg" },
    { name: "OpenCV", src: "media/logos/opencv.svg" },
    { name: "NumPy", src: "media/logos/numpy.svg" },
    { name: "Flask", src: "media/logos/flask.svg" },
    { name: "Picamera2", src: "media/logos/picamera2.svg" },
    { name: "three.js", src: "media/logos/three-js.svg" },
    { name: "anime.js", src: "media/logos/anime-js.svg" },
    { name: "Blender", src: "media/logos/blender.svg" },
    { name: "HTML5", src: "media/logos/html5.svg" },
    { name: "CSS3", src: "media/logos/css3.svg" },
    { name: "JavaScript", src: "media/logos/javascript.svg" },
    { name: "systemd", src: "media/logos/systemd.svg" },
    { name: "Cloudflare", src: "media/logos/cloudflare.svg" },
    { name: "pytest", src: "media/logos/pytest.svg" },
    { name: "GitHub Actions", src: "media/logos/github-actions.svg" },
  ];
  lazyMount("stack-grid", () => import("./js/fx/interactive-grid.js"), (mod, host) =>
    mod.createInteractiveGrid(host, STACK_ITEMS, { reducedMotion: still, cols: 6 }));
}


// Without WebGL the gallery list is shown as a grid: give its items their media.
if (!webgl) {
  document.querySelectorAll("#gallery-list > li[data-src]").forEach((li) => {
    const video = li.dataset.kind === "video" || /\.(mp4|webm|mov)$/i.test(li.dataset.src);
    const media = document.createElement(video ? "video" : "img");
    media.src = li.dataset.src;
    if (video) Object.assign(media, { muted: true, loop: true, playsInline: true, controls: true, preload: "metadata" });
    else Object.assign(media, { alt: li.dataset.alt || li.textContent.trim(), loading: "lazy" });
    const cap = document.createElement("span");
    cap.textContent = li.textContent.trim();
    li.replaceChildren(media, cap);
  });
}

async function boot() {
  const deepLink = location.hash && location.hash !== "#top" ? location.hash : null;
  const gate = createGate();
  const gated = !still && !gate.alreadySeen;
  if (gated) root.classList.add("is-gated");
  else gate.close();

  // The hero title (Vector Wordmark) and its small particle orb: mounted early so they're
  // ready the moment the gate hands off, WebGL only (the plain "COOPER" text and no gimbal
  // at all are the fallback everywhere else — see styles.css).
  let wordmark = null, gimbal = null;
  if (webgl) {
    import("./js/fx/vector-wordmark.js").then(({ createVectorWordmark }) => {
      const host = document.getElementById("vector-wordmark-host");
      if (host) wordmark = createVectorWordmark(host, { text: "COOPER", textColor: "#EEEDEA", shade: "#9C9B98", accent: "#FF5A1F", reducedMotion: still });
    });
    if (!still) {
      import("./js/fx/particle-gimbal.js").then(({ createParticleGimbal }) => {
        const host = document.getElementById("intro-gimbal");
        if (host) gimbal = createParticleGimbal(host, { dotColor: "#EEEDEA", accentColor: "#FF5A1F" });
      });
    }
  }

  gate.progress(0.04, "Acquiring");
  const fonts = Promise.all([
    document.fonts.load('800 100px "Archivo"'),
    document.fonts.load('400 12px "Martian Mono"'),
  ]).catch(() => {}).then(() => gate.progress(0.25, "Fonts"));

  const anime = await import("animejs");
  gate.progress(0.4, "Motion");
  const [{ createStage }, { initChapters }, { playIntro, makeScrambler }, { initCursor }] = await Promise.all([
    import("./js/stage/stage.js"),
    import("./js/chapters.js"),
    import("./js/intro.js"),
    import("./js/cursor.js"),
  ]);
  gate.progress(0.78, "Scene");
  await fonts;

  const stage = createStage({ still, webgl, scramble: makeScrambler(anime) });
  stage.warm();
  if (/[?&]debug\b/.test(location.search)) window.__coop = { stage, anime };
  gate.progress(0.95, "Calibrating");
  initCursor({ still });
  window.addEventListener("pointermove", (e) => {
    stage.setPointer((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  }, { passive: true });

  if (gated) {
    await gate.ready();
    gate.close();
  }
  stage.start();
  initChapters(anime, stage, { still });
  if (deepLink) {
    const target = document.querySelector(deepLink);
    if (target) target.scrollIntoView({ behavior: "instant" });
  }
  await playIntro(anime, { still, skip: !!deepLink });
}

boot().catch((err) => {
  // Never leave a visitor stuck behind the gate.
  console.error(err);
  root.classList.add("is-entered", "boot-failed");
  root.classList.remove("is-gated");
});
