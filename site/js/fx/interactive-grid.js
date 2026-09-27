/* Interactive Grid — tech-stack "built with" tile field.
 *
 * A bordered sheet of logo tiles where the card under the pointer lifts
 * toward the viewer (scale + translateZ) and glows, and its four
 * grid-adjacent neighbours (up/down/left/right, not diagonal) lift a
 * smaller amount with a dimmer glow — so hovering one tile visibly moves
 * a small neighbourhood of tiles, not just the single card under the
 * cursor. This mirrors the source component's actual mechanic: discrete
 * per-card state (plain / big / small) driven by pointerenter /
 * pointerleave, not a continuous per-frame pointer-following tilt (the
 * source never computed one either — the grid's own perspective/rotate
 * is fixed at 0/0 in this preset).
 *
 * Settings (David's call): 6 columns wide (fewer as the host narrows),
 * enough rows to show every item, outer padding 40px, gap 0 rendered as
 * shared hairline borders instead of a real grid gap (so the sheet reads
 * as one bordered surface, not floating cards, with rounding only on its
 * four outer corners), logo scale 3 (60% of each card's box), card fill
 * #060606, border #222222, shadow off, glow on #FF5A1F66 -> #FF5A1F at
 * intensity 40 (6.4px / 3.2px drop-shadow blur, see interactive-grid.css),
 * perspective 1600px, rotateX/rotateY 0/0.
 *
 * Porting notes:
 *   - Logos are local SVGs the caller supplies via `items`, not hotlinked
 *     images, each rendered with real alt text.
 *   - The source's `transition: all` is replaced everywhere with explicit
 *     transform / opacity / filter transitions.
 *   - Column count is this module's own responsibility: a ResizeObserver
 *     on `host` switches 6 -> 3 -> 2 columns as it narrows, and the
 *     hover-neighbour math is recomputed against the live column count,
 *     so "up/down/left/right" always matches what is actually adjacent
 *     on screen, phones included.
 *   - `options.reducedMotion`, plus a live `prefers-reduced-motion`
 *     check, disables the whole pointer-tilt/glow mechanic: cards render
 *     flat and static, fully visible with alt text intact.
 *   - No per-frame work at all: everything is event-driven
 *     (pointerenter/pointerleave), and gated by an IntersectionObserver
 *     (host off-screen) and document.hidden so an inactive tab or an
 *     off-screen section never runs even that event-driven logic.
 */

const LEAVE_DELAY = 200; // ms — matches the source's hover-out grace period

function clampCols(n) {
  return Math.max(1, Math.round(n || 1));
}

/**
 * @param {HTMLElement} host - existing empty container element.
 * @param {{name: string, src: string, alt: string}[]} items - logo tiles, in order.
 * @param {object} [options]
 * @param {boolean} [options.reducedMotion] - force the flat/static look.
 * @param {number} [options.cols] - base (widest) column count, default 6.
 * @returns {{ destroy(): void }}
 */
export function createInteractiveGrid(host, items, options = {}) {
  if (!host || typeof host.appendChild !== 'function') {
    throw new Error('createInteractiveGrid(host, items, options) requires an existing element');
  }

  const list = Array.isArray(items) ? items.filter((it) => it && it.src) : [];
  const total = list.length;
  const baseCols = clampCols(options.cols ?? 6);
  const forceReducedMotion = options.reducedMotion === true;

  host.innerHTML = '';

  const root = document.createElement('div');
  root.className = 'interactive-grid';

  const sheet = document.createElement('div');
  sheet.className = 'interactive-grid__sheet';
  root.appendChild(sheet);

  const cards = list.map((item) => {
    const card = document.createElement('div');
    card.className = 'interactive-grid__card';
    const img = document.createElement('img');
    img.src = item.src;
    img.alt = item.alt || item.name || '';
    img.draggable = false;
    card.appendChild(img);
    sheet.appendChild(card);
    return card;
  });

  host.appendChild(root);

  if (total === 0) {
    return {
      destroy() {
        root.remove();
      },
    };
  }

  // ---- responsive columns (this module's own layout call) --------------
  // Kept in JS rather than a CSS media query so the neighbour math below
  // (which depends on the live column count) always matches reality.

  let cols = baseCols;

  function colsForWidth(w) {
    if (w >= 720) return baseCols;
    if (w >= 420) return Math.min(baseCols, 3);
    return Math.min(baseCols, 2);
  }

  const CORNER_CLASSES = ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br'];

  function layout() {
    sheet.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    const rows = Math.ceil(total / cols);
    const topLeft = 0;
    const topRight = Math.min(cols, total) - 1;
    const bottomLeft = Math.min((rows - 1) * cols, total - 1);
    const bottomRight = total - 1;
    cards.forEach((card) => card.classList.remove(...CORNER_CLASSES));
    cards[topLeft].classList.add('corner-tl');
    cards[topRight].classList.add('corner-tr');
    cards[bottomLeft].classList.add('corner-bl');
    cards[bottomRight].classList.add('corner-br');
  }

  function applyWidth(w) {
    const next = colsForWidth(w);
    if (next === cols) return;
    cols = next;
    layout();
  }

  layout();

  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
        const w = entries[entries.length - 1].contentRect.width;
        applyWidth(w);
      })
    : null;
  if (ro) ro.observe(host);
  else if (typeof window !== 'undefined') applyWidth(host.clientWidth || window.innerWidth);

  // ---- hover mechanic: hovered card + its 4 grid-adjacent neighbours ----

  let hovered = -1;
  let leaveTimer = null;

  function neighboursOf(i) {
    const out = [];
    if (i % cols !== 0) out.push(i - 1);
    if (i % cols !== cols - 1) out.push(i + 1);
    out.push(i - cols);
    out.push(i + cols);
    return out.filter((n) => n >= 0 && n < total);
  }

  function render() {
    const neighbours = hovered >= 0 ? neighboursOf(hovered) : [];
    cards.forEach((card, i) => {
      card.classList.toggle('is-big', i === hovered);
      card.classList.toggle('is-small', i !== hovered && neighbours.includes(i));
    });
  }

  function clearLeaveTimer() {
    if (leaveTimer) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
  }

  // ---- gating: reduced motion / off-screen / hidden tab -----------------

  const reduceMotionQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  function isStatic() {
    return forceReducedMotion || !!(reduceMotionQuery && reduceMotionQuery.matches);
  }

  let intersecting = true;
  let active = false;

  function updateActive() {
    sheet.classList.toggle('is-static', isStatic());
    const next = intersecting && !document.hidden && !isStatic();
    if (next === active) return;
    active = next;
    if (!active) {
      clearLeaveTimer();
      hovered = -1;
      render();
    }
  }

  cards.forEach((card, i) => {
    card.addEventListener('pointerenter', () => {
      if (!active) return;
      clearLeaveTimer();
      hovered = i;
      render();
    });
  });

  sheet.addEventListener('pointerleave', () => {
    if (!active) return;
    clearLeaveTimer();
    leaveTimer = setTimeout(() => {
      hovered = -1;
      render();
    }, LEAVE_DELAY);
  });

  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
        intersecting = entries[entries.length - 1].isIntersecting;
        updateActive();
      }, { threshold: 0 })
    : null;
  if (io) io.observe(host);

  function onVisibilityChange() {
    updateActive();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  function onReducedMotionChange() {
    updateActive();
  }
  if (reduceMotionQuery) {
    if (reduceMotionQuery.addEventListener) {
      reduceMotionQuery.addEventListener('change', onReducedMotionChange);
    } else if (reduceMotionQuery.addListener) {
      // Safari < 14
      reduceMotionQuery.addListener(onReducedMotionChange);
    }
  }

  updateActive();

  return {
    destroy() {
      clearLeaveTimer();
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (reduceMotionQuery) {
        if (reduceMotionQuery.removeEventListener) {
          reduceMotionQuery.removeEventListener('change', onReducedMotionChange);
        } else if (reduceMotionQuery.removeListener) {
          reduceMotionQuery.removeListener(onReducedMotionChange);
        }
      }
      root.remove();
    },
  };
}
