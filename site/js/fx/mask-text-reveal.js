// Mask Text Reveal — scroll-triggered clip-path unmask (left-to-right).
// Each element is masked with `clip-path: inset(0 100% 0 0)` (clipped from
// the right edge, hiding the text) and unmasked to `inset(0 0 0 0)` the
// first time it enters the viewport. Reveal-once: no re-hide on scroll-up.

const DEFAULTS = {
  reducedMotion: false,
  duration: 800,
  easing: "cubic-bezier(0.44,0,0.56,1)",
};

export function initMaskTextReveal(elements, options = {}) {
  const els = Array.from(elements || []).filter(Boolean);
  const { reducedMotion, duration, easing } = { ...DEFAULTS, ...options };

  if (reducedMotion) {
    els.forEach((el) => {
      el.classList.add("mask-reveal", "is-revealed");
    });
    return { destroy() {} };
  }

  els.forEach((el) => {
    el.classList.add("mask-reveal");
    el.style.setProperty("--mask-duration", `${duration}ms`);
    el.style.setProperty("--mask-easing", easing);
  });

  const pending = new Set(els);

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-revealed");
        observer.unobserve(entry.target);
        pending.delete(entry.target);
      }
    },
    { threshold: 0.1 }
  );

  pending.forEach((el) => observer.observe(el));

  return {
    destroy() {
      pending.forEach((el) => observer.unobserve(el));
      pending.clear();
      observer.disconnect();
    },
  };
}
