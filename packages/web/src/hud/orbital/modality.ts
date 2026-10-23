/**
 * Whether the person is using the keyboard or the mouse right now. A dialog moves the focus into itself, and back to the button that opened
 * it, only for the keyboard: after a mouse click a focused button would swallow Space, and Space is the talk key.
 */
let keyboard = false;
if (typeof document !== "undefined") {
  document.addEventListener("keydown", () => (keyboard = true), true);
  document.addEventListener("pointerdown", () => (keyboard = false), true);
  document.addEventListener("mousedown", () => (keyboard = false), true);
}
export const usingKeyboard = (): boolean => keyboard;