(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const revealables = document.querySelectorAll(".reveal");

  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealables.forEach((el) => el.classList.add("is-visible"));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    revealables.forEach((el) => io.observe(el));
  }

  // Links still pointing at "#" are unfilled placeholders: make them inert, not a jump to top.
  document.querySelectorAll('a[data-placeholder][href="#"]').forEach((a) => {
    a.setAttribute("aria-disabled", "true");
    a.title = "Coming soon";
    a.addEventListener("click", (e) => e.preventDefault());
  });
})();
