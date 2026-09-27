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
  const gated = !still;
  const gate = createGate();
  if (gated) root.classList.add("is-gated");
  else gate.close();

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
