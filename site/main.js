// COOPER showcase entry. Boots straight into the hero: fonts → anime.js → three.js + the
// scene → intro.

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
  root.classList.add("is-entered");

  // The hero title: the Vector Wordmark, WebGL only (the plain "COOPER" text is the fallback
  // everywhere else, see styles.css).
  if (webgl) {
    import("./js/fx/vector-wordmark.js").then(({ createVectorWordmark }) => {
      const host = document.getElementById("vector-wordmark-host");
      if (host) createVectorWordmark(host, { text: "COOPER", textColor: "#EEEDEA", shade: "#9C9B98", reducedMotion: still });
    });
  }

  const fonts = Promise.all([
    document.fonts.load('800 100px "Archivo"'),
    document.fonts.load('400 12px "Martian Mono"'),
  ]).catch(() => {});

  const anime = await import("animejs");
  const [{ createStage }, { initChapters }, { playIntro, makeScrambler }, { initCursor }] = await Promise.all([
    import("./js/stage/stage.js"),
    import("./js/chapters.js"),
    import("./js/intro.js"),
    import("./js/cursor.js"),
  ]);
  await fonts;

  const stage = createStage({ still, webgl, scramble: makeScrambler(anime) });
  stage.warm();
  if (/[?&]debug\b/.test(location.search)) window.__coop = { stage, anime };
  initCursor({ still });
  window.addEventListener("pointermove", (e) => {
    stage.setPointer((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  }, { passive: true });

  stage.start();
  initChapters(anime, stage, { still });
  if (deepLink) {
    const target = document.querySelector(deepLink);
    if (target) target.scrollIntoView({ behavior: "instant" });
  }
  await playIntro(anime, { still, skip: !!deepLink });
}

boot().catch((err) => {
  // Never leave the hero copy hidden: boot-failed shows it without the intro.
  console.error(err);
  root.classList.add("is-entered", "boot-failed");
});
