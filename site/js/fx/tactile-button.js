// Tactile Button: a link that visually depresses on press and springs back
// on release, like a real keycap sitting on a raised base. Pairs with
// tactile-button.css, which defines the classes this module applies.
//
// The mechanic: a solid "base" layer sits underneath the face, offset down
// and slightly left. Pressing (pointer or keyboard) slides the face down
// onto that base with a fast, stiff move; releasing springs it back up.
// Hover/focus swap the face's fill and text color independently of press
// state, matching the original component's split between a "paint" (color)
// transition and a "press" (transform) transition.

const PRESSED_CLASS = "is-pressed";
const FACE_CLASS = "tactile-btn-face";
const LABEL_CLASS = "tactile-btn-label";
const SCOPE_CLASS = "tactile-btn-scope";
const BASE_CLASS = "tactile-btn-base";
const WRAP_CLASS = "tactile-btn";
const REDUCED_CLASS = "tactile-btn--reduced";

/**
 * Enhance an existing <a> element with the tactile press/release mechanic.
 * Does not replace, clone or remove `el`; it stays the same node (same
 * href, same focusability), just moved under a couple of wrapper layers.
 *
 * @param {HTMLElement} el - an existing <a> already in the DOM, carrying
 *   its href and visible label text.
 * @param {{ reducedMotion?: boolean }} [options]
 * @returns {{ destroy(): void }}
 */
export function createTactileButton(el, options = {}) {
  if (!el || el.dataset.tactileButtonReady === "true") {
    return { destroy() {} };
  }
  el.dataset.tactileButtonReady = "true";

  const reducedMotion = !!options.reducedMotion;
  const labelText = el.textContent;

  // Build the layers: wrap (padding for the base offset) > scope (sizes to
  // the face) > base (the offset layer underneath) + face (el itself, on top).
  const wrap = document.createElement("span");
  wrap.className = WRAP_CLASS;
  if (reducedMotion) wrap.classList.add(REDUCED_CLASS);

  const scope = document.createElement("span");
  scope.className = SCOPE_CLASS;

  const base = document.createElement("span");
  base.className = BASE_CLASS;
  base.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = LABEL_CLASS;
  label.textContent = labelText;

  const parent = el.parentNode;
  if (parent) parent.insertBefore(wrap, el);

  el.textContent = "";
  el.appendChild(label);
  el.classList.add(FACE_CLASS);

  scope.appendChild(base);
  scope.appendChild(el);
  wrap.appendChild(scope);

  let pressed = false;
  const setPressed = (next) => {
    if (pressed === next) return;
    pressed = next;
    el.classList.toggle(PRESSED_CLASS, pressed);
  };

  const onPointerDown = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    setPressed(true);
  };
  const onPointerUp = () => setPressed(false);
  const onPointerCancel = () => setPressed(false);
  const onPointerLeave = () => setPressed(false);

  // Safety net for releases that happen outside the element (matches the
  // original's window-level pointerup/pointercancel listeners).
  const onWindowRelease = () => setPressed(false);

  const isActivationKey = (key) =>
    key === "Enter" || key === " " || key === "Spacebar";

  const onKeyDown = (event) => {
    if (event.repeat || !isActivationKey(event.key)) return;
    // Space doesn't natively activate an <a>; stop it from scrolling the
    // page and activate it ourselves on keyup instead.
    if (event.key !== "Enter") event.preventDefault();
    setPressed(true);
  };
  const onKeyUp = (event) => {
    if (!isActivationKey(event.key)) return;
    setPressed(false);
    if (event.key !== "Enter") {
      event.preventDefault();
      el.click();
    }
  };
  const onBlur = () => setPressed(false);

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerCancel);
  el.addEventListener("pointerleave", onPointerLeave);
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("keyup", onKeyUp);
  el.addEventListener("blur", onBlur);
  window.addEventListener("pointerup", onWindowRelease);
  window.addEventListener("pointercancel", onWindowRelease);

  return {
    destroy() {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
      el.removeEventListener("pointerleave", onPointerLeave);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("keyup", onKeyUp);
      el.removeEventListener("blur", onBlur);
      window.removeEventListener("pointerup", onWindowRelease);
      window.removeEventListener("pointercancel", onWindowRelease);
    },
  };
}
