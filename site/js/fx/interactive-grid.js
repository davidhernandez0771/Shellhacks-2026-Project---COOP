/* Interactive Grid: the tech-stack tile sheet at the end of the Build chapter.
 *
 * Progressive enhancement of a plain list that is already in the HTML (index.html,
 * #stack-grid): each <li> is a tile with a logo <img> and its name. The layout, the
 * column count and the resting look are pure CSS (interactive-grid.css), so the grid
 * reads the same without JS. This module only adds the hover mechanic from OriginKit's
 * Interactive Grid: the tile under the pointer lifts and glows, and its four grid-adjacent
 * neighbours (up/down/left/right, not diagonal) lift a little with a dimmer glow.
 *
 * Porting notes (vs. the OriginKit source):
 *   - the tiles are real markup with alt text, not generated from hotlinked images;
 *   - the column count comes from the sheet's computed grid-template-columns, so the
 *     neighbour math always matches the live CSS breakpoint;
 *   - no per-frame work: pointerenter/pointerleave only, and only on (hover: hover)
 *     devices without prefers-reduced-motion (or options.reducedMotion);
 *   - transitions are transform/filter only (see the CSS), no `transition: all` and no
 *     infinite glow animation.
 */

const LEAVE_DELAY = 200; // ms, the source's hover-out grace period

/**
 * @param {HTMLElement} sheet - the grid element whose children are the tiles.
 * @param {object} [options]
 * @param {boolean} [options.reducedMotion] - force the static look.
 * @returns {{ destroy(): void }}
 */
export function createInteractiveGrid(sheet, options = {}) {
  const noop = { destroy() {} };
  if (!sheet) return noop;

  const hoverQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const cards = Array.from(sheet.children);
  if (!cards.length) return noop;

  let hovered = -1;
  let leaveTimer = 0;

  const enabled = () => options.reducedMotion !== true && hoverQuery.matches && !motionQuery.matches;
  const columns = () => getComputedStyle(sheet).gridTemplateColumns.split(" ").filter(Boolean).length || 1;

  function render() {
    const cols = columns();
    const near = new Set();
    if (hovered >= 0) {
      if (hovered % cols !== 0) near.add(hovered - 1);
      if (hovered % cols !== cols - 1) near.add(hovered + 1);
      near.add(hovered - cols);
      near.add(hovered + cols);
    }
    cards.forEach((card, i) => {
      card.classList.toggle("is-big", i === hovered);
      card.classList.toggle("is-small", near.has(i));
    });
  }

  function set(i) {
    clearTimeout(leaveTimer);
    if (i === hovered) return;
    hovered = i;
    render();
  }

  const onEnter = (e) => {
    if (enabled()) set(cards.indexOf(e.currentTarget));
  };
  const onLeave = () => {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => set(-1), LEAVE_DELAY);
  };
  const onChange = () => {
    if (!enabled()) set(-1);
  };

  cards.forEach((card) => card.addEventListener("pointerenter", onEnter));
  sheet.addEventListener("pointerleave", onLeave);
  hoverQuery.addEventListener("change", onChange);
  motionQuery.addEventListener("change", onChange);
  sheet.classList.add("is-live");

  return {
    destroy() {
      clearTimeout(leaveTimer);
      cards.forEach((card) => card.removeEventListener("pointerenter", onEnter));
      sheet.removeEventListener("pointerleave", onLeave);
      hoverQuery.removeEventListener("change", onChange);
      motionQuery.removeEventListener("change", onChange);
      sheet.classList.remove("is-live");
      set(-1);
    },
  };
}
