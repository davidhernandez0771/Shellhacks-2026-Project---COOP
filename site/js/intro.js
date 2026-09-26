// The intro: "COOP" decodes out of noise like a camera acquiring a lock, then the line under
// it re-scrambles into the full name, then into the tagline.

const NAME = "Computer-vision Object Observation & Prediction";
const TAGLINE = "COOP keeps an eye on the coop.";
const NAME_HTML = "<b>C</b>omputer-vision <b>O</b>bject <b>O</b>bservation &amp; <b>P</b>rediction";
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

function setFinal(letters, expansion, readout, brackets) {
  letters.forEach((s, i) => { s.textContent = "COOP"[i]; s.classList.add("is-set"); });
  expansion.innerHTML = NAME_HTML;
  readout.textContent = TAGLINE;
  brackets.classList.add("is-lock");
  brackets.querySelectorAll("i").forEach((i) => { i.style.opacity = "1"; });
}

export function playIntro(anime, { still, skip }) {
  const { animate, createTimeline, stagger, scrambleText } = anime;
  const wrap = document.getElementById("intro-letters");
  const letters = Array.from(wrap.children);
  const expansion = document.getElementById("intro-expansion");
  const readout = document.getElementById("intro-readout");
  const brackets = document.querySelector(".intro-word .brackets");
  const lede = document.getElementById("intro-lede");
  const cue = document.getElementById("scroll-cue");

  // Fix every letter cell to its final glyph's width so the scramble never reflows the word.
  letters.forEach((s) => { s.style.width = ""; });
  const widths = letters.map((s) => s.getBoundingClientRect().width);
  letters.forEach((s, i) => { s.style.width = `${widths[i]}px`; });

  if (still || skip) {
    setFinal(letters, expansion, readout, brackets);
    lede.style.opacity = "1";
    cue.style.opacity = "1";
    return Promise.resolve();
  }

  letters.forEach((s) => { s.textContent = ""; });
  wrap.classList.add("is-scrambling");
  const bracketEls = brackets.querySelectorAll("i");
  const tl = createTimeline({ defaults: { ease: "outExpo" } });

  // 1. brackets close in from wide, like an autofocus hunting
  tl.add(bracketEls, {
    opacity: [0, 1],
    x: (el, i) => [i % 2 ? 60 : -60, 0],
    y: (el, i) => [i < 2 ? -40 : 40, 0],
    duration: 1100,
    delay: stagger(40),
  }, 0);

  // 2. the letters decode out of noise, one cell at a time
  letters.forEach((s, i) => {
    tl.add(s, {
      innerHTML: scrambleText({
        text: "COOP"[i],
        chars: NOISE,
        cursor: CURSOR,
        settleDuration: 520 + i * 90,
        settleRate: 24,
        revealRate: 30,
        override: "",
      }),
      duration: 700 + i * 140,
      ease: "linear",
      onComplete: () => s.classList.add("is-set"),
    }, 250 + i * 130);
  });

  // 3. lock: brackets snap to orange with a small overshoot
  tl.call(() => { brackets.classList.add("is-lock"); wrap.classList.remove("is-scrambling"); }, 1450);
  tl.add(bracketEls, { scale: [1.35, 1], duration: 500, ease: "outBack(2)" }, 1450);

  // 4. the readout decodes into the full name...
  tl.add(readout, {
    innerHTML: scrambleText({ text: NAME, chars: NOISE, cursor: CURSOR, revealRate: 70, settleDuration: 260, override: "", perturbation: 0.3 }),
    ease: "linear",
  }, 1650);

  // 5. ...which then re-scrambles into the tagline, while the name settles above the word
  tl.add(readout, {
    innerHTML: scrambleText({ text: TAGLINE, chars: NOISE, cursor: CURSOR, revealRate: 55, settleDuration: 300, perturbation: 0.25 }),
    ease: "linear",
  }, 3650);
  tl.add(expansion, {
    innerHTML: scrambleText({ text: NAME, chars: "A-Za-z", revealRate: 110, settleDuration: 180, override: "" }),
    ease: "linear",
    onComplete: () => { expansion.innerHTML = NAME_HTML; },
  }, 3700);

  tl.add([lede, cue], { opacity: [0, 1], y: [10, 0], duration: 900, delay: stagger(140) }, 4300);

  return new Promise((resolve) => {
    tl.then(() => resolve());
  });
}
