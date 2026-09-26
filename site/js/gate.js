// Loader: a dotted ring that fills with real load progress, then an "Enter >>>" prompt.

const DOTS = 48;

export function createGate() {
  const root = document.documentElement;
  const gate = document.getElementById("gate");
  const svg = document.getElementById("gate-ring");
  const pctEl = document.getElementById("gate-pct");
  const statusEl = document.getElementById("gate-status");
  const enterBtn = document.getElementById("gate-enter");
  const NS = "http://www.w3.org/2000/svg";

  // four reticle ticks outside the ring
  for (const a of [0, 90, 180, 270]) {
    const r = (a * Math.PI) / 180;
    const l = document.createElementNS(NS, "line");
    l.setAttribute("x1", (100 + Math.sin(r) * 94).toFixed(2));
    l.setAttribute("y1", (100 - Math.cos(r) * 94).toFixed(2));
    l.setAttribute("x2", (100 + Math.sin(r) * 104).toFixed(2));
    l.setAttribute("y2", (100 - Math.cos(r) * 104).toFixed(2));
    svg.appendChild(l);
  }
  const dots = [];
  for (let i = 0; i < DOTS; i++) {
    const a = (i / DOTS) * Math.PI * 2 - Math.PI / 2;
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", (100 + Math.cos(a) * 84).toFixed(2));
    c.setAttribute("cy", (100 + Math.sin(a) * 84).toFixed(2));
    c.setAttribute("r", i % 4 === 0 ? "2.1" : "1.4");
    svg.appendChild(c);
    dots.push(c);
  }

  let target = 0, shown = 0, raf = 0;
  const reduce = root.classList.contains("still");
  function tick() {
    shown += (target - shown) * (reduce ? 1 : 0.12);
    if (Math.abs(target - shown) < 0.002) shown = target;
    const on = Math.round(shown * DOTS);
    dots.forEach((d, i) => d.classList.toggle("on", i < on));
    pctEl.textContent = String(Math.round(shown * 100)).padStart(3, "0");
    raf = shown < target ? requestAnimationFrame(tick) : 0;
  }

  return {
    progress(p, label) {
      target = Math.max(target, Math.min(1, p));
      if (label) statusEl.textContent = label;
      if (!raf) raf = requestAnimationFrame(tick);
    },
    /** Resolves when the visitor enters. */
    ready() {
      target = 1;
      return new Promise((resolve) => {
        const finish = () => {
          dots.forEach((d) => d.classList.add("on"));
          pctEl.textContent = "100";
          statusEl.textContent = "Locked";
          svg.classList.add("is-lock");
          dots.forEach((d, i) => setTimeout(() => d.classList.add("lock"), reduce ? 0 : i * 8));
          enterBtn.hidden = false;
          enterBtn.focus({ preventScroll: true });
          const go = () => {
            window.removeEventListener("keydown", onKey);
            resolve();
          };
          const onKey = (e) => { if (e.key === "Enter" && document.activeElement !== enterBtn) go(); };
          enterBtn.addEventListener("click", go, { once: true });
          window.addEventListener("keydown", onKey);
        };
        const wait = () => (shown >= 0.999 ? finish() : requestAnimationFrame(wait));
        if (!raf) raf = requestAnimationFrame(tick);
        wait();
      });
    },
    close() {
      root.classList.add("is-entered");
      root.classList.remove("is-gated");
      gate.setAttribute("aria-hidden", "true");
    },
    el: gate,
  };
}
