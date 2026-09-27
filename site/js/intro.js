// The intro: acquisition brackets close in on the COOPER wordmark (rendered by the Vector
// Wordmark component, js/fx/vector-wordmark.js), then the readout decodes into the tagline.

const TAGLINE = "COOPER sees it coming.";
const CURSOR = "░▒▓█";
const NOISE = "░▒▓█▚▞▙▛▜▟ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%";

/** Scramble helper shared with the overlay labels. */
export function makeScrambler(anime) {
  const { animate, scrambleText } = anime;
  return (el, text, fromCurrent = false, opts = {}) => {
    if (!fromCurrent) el.textContent = "";
    return animate(el, {
      innerHTML: scrambleText({
        text,
        chars: opts.chars || "A-Z0-9#%·",
        cursor: opts.cursor ?? CURSOR,
        revealRate: opts.revealRate || 90,
        settleDuration: opts.settle || 220,
        from: opts.from || "left",
        perturbation: opts.perturbation ?? 0.2,
        override: opts.override,
      }),
      ...(opts.delay ? { delay: opts.delay } : {}),
    });
  };
}

function setFinal(readout, brackets, wordmarkHost) {
  readout.textContent = TAGLINE;
  brackets.classList.add("is-lock");
  brackets.querySelectorAll("i").forEach((i) => { i.style.opacity = "1"; });
  if (wordmarkHost) wordmarkHost.style.opacity = "1";
}

export function playIntro(anime, { still, skip }) {
  const { animate, createTimeline, stagger, scrambleText } = anime;
  const readout = document.getElementById("intro-readout");
  const brackets = document.querySelector(".intro-word .brackets");
  const wordmarkHost = document.getElementById("vector-wordmark-host");
  const lede = document.getElementById("intro-lede");
  const ctas = document.getElementById("intro-ctas");
  const cue = document.getElementById("scroll-cue");

  if (still || skip) {
    setFinal(readout, brackets, wordmarkHost);
    lede.style.opacity = "1";
    ctas.style.opacity = "1";
    cue.style.opacity = "1";
    return Promise.resolve();
  }

  const bracketEls = brackets.querySelectorAll("i");
  if (wordmarkHost) wordmarkHost.style.opacity = "0";
  const tl = createTimeline({ defaults: { ease: "outExpo" } });

  // 1. brackets close in from wide, like an autofocus hunting
  tl.add(bracketEls, {
    opacity: [0, 1],
    x: (el, i) => [i % 2 ? 60 : -60, 0],
    y: (el, i) => [i < 2 ? -40 : 40, 0],
    duration: 1100,
    delay: stagger(40),
  }, 0);

  // 2. lock: brackets snap to orange with a small overshoot, and the wordmark's own
  // reveal sweep (js/fx/vector-wordmark.js) takes over from here
  tl.call(() => { brackets.classList.add("is-lock"); }, 1450);
  tl.add(bracketEls, { scale: [1.35, 1], duration: 500, ease: "outBack(2)" }, 1450);
  if (wordmarkHost) tl.add(wordmarkHost, { opacity: [0, 1], duration: 600 }, 1500);

  // 3. the readout decodes straight into the tagline
  tl.add(readout, {
    innerHTML: scrambleText({ text: TAGLINE, chars: NOISE, cursor: CURSOR, revealRate: 55, settleDuration: 300, perturbation: 0.25 }),
    ease: "linear",
  }, 1900);

  tl.add([lede, ctas, cue], { opacity: [0, 1], y: [10, 0], duration: 900, delay: stagger(140) }, 2900);

  return new Promise((resolve) => {
    tl.then(() => resolve());
  });
}
