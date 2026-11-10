/**
 * Layers the Android back button closes before the mobile shell's own
 * surfaces and drawers: the newest one first, one per press.
 *
 * Two kinds of layer sit above a shell surface. Base UI popups (dialogs,
 * selects, menus) already close on Escape and move focus into themselves, so
 * back sends Escape to the focused element and only the popup holding focus
 * reacts. MobileOverlayPanel sheets manage no focus, so they register here.
 */

const OPEN_POPUP_SELECTOR = [
  '[data-open][role="dialog"]',
  '[data-open][role="alertdialog"]',
  '[data-open][role="menu"]',
  '[data-open][role="listbox"]',
  '[data-open][role="presentation"]',
].join(', ');

const overlayLayers: Array<{ close: () => void }> = [];
const overlayListeners = new Set<() => void>();

const notifyOverlayListeners = (): void => {
  overlayListeners.forEach((listener) => listener());
};

/** Registers an open overlay; the returned function unregisters it. */
export function registerBackLayer(close: () => void): () => void {
  const layer = { close };
  overlayLayers.push(layer);
  notifyOverlayListeners();
  return () => {
    const index = overlayLayers.indexOf(layer);
    if (index < 0) return;
    overlayLayers.splice(index, 1);
    notifyOverlayListeners();
  };
}

export function isTopmostBackLayer(close: () => void): boolean {
  return overlayLayers.at(-1)?.close === close;
}

export function isInsideOpenPopup(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OPEN_POPUP_SELECTOR) !== null;
}

/** Whether `closeTopmostBackLayer` has something to close. */
export function hasOpenBackLayer(): boolean {
  return overlayLayers.length > 0 || isInsideOpenPopup(document.activeElement);
}

/**
 * Calls the listener when `hasOpenBackLayer` may have changed. A popup counts
 * while it holds focus, so focus moves are its signal. They are read a task
 * later: focus crossing between two fields passes through the body.
 */
export function subscribeBackLayers(listener: () => void): () => void {
  let timer: number | null = null;
  const handleFocusChange = () => {
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      listener();
    }, 0);
  };
  overlayListeners.add(listener);
  document.addEventListener('focusin', handleFocusChange);
  document.addEventListener('focusout', handleFocusChange);
  return () => {
    if (timer !== null) window.clearTimeout(timer);
    overlayListeners.delete(listener);
    document.removeEventListener('focusin', handleFocusChange);
    document.removeEventListener('focusout', handleFocusChange);
  };
}

/** Closes the topmost layer; false when nothing above the shell is open. */
export function closeTopmostBackLayer(): boolean {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && isInsideOpenPopup(focused)) {
    focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return true;
  }
  const top = overlayLayers.at(-1);
  if (!top) return false;
  top.close();
  return true;
}
