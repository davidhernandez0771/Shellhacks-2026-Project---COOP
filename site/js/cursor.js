// Desktop cursor: a dot and a ring that becomes lock brackets over anything you can act on,
// and a drag hint over the gallery. Fine pointers only; touch devices keep their own.

export function initCursor({ still }) {
  if (!window.matchMedia("(pointer: fine)").matches) return;
  const root = document.documentElement;
  const el = document.getElementById("cursor");
  const label = document.getElementById("cursor-label");
  root.classList.add("has-cursor");

  let x = -100, y = -100, rx = -100, ry = -100, raf = 0;
  const loop = () => {
    const k = still ? 1 : 0.28;
    rx += (x - rx) * k;
    ry += (y - ry) * k;
    el.style.transform = `translate3d(${rx.toFixed(1)}px, ${ry.toFixed(1)}px, 0)`;
    raf = Math.abs(x - rx) + Math.abs(y - ry) > 0.2 ? requestAnimationFrame(loop) : 0;
  };
  window.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    x = e.clientX; y = e.clientY;
    if (!el.classList.contains("is-live")) { rx = x; ry = y; el.classList.add("is-live"); }
    const target = e.target;
    const actionable = target.closest && target.closest("a, button");
    const drag = !actionable && root.classList.contains("gallery-active") && target.closest && target.closest("#gallery");
    el.classList.toggle("is-lock", !!actionable);
    el.classList.toggle("is-drag", !!drag);
    label.textContent = drag ? "Drag" : "";
    if (!raf) raf = requestAnimationFrame(loop);
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => el.classList.remove("is-live"));
  // after a click that removes or covers the hovered element (e.g. an in-page link that scrolls away), drop the lock look
  window.addEventListener("click", () => requestAnimationFrame(() => {
    const under = document.elementFromPoint(x, y);
    el.classList.toggle("is-lock", !!(under && under.closest && under.closest("a, button")));
  }));
}
