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

/** Registers an open overlay; the returned function unregisters it. */
export function registerBackLayer(close: () => void): () => void {
  const layer = { close };
  overlayLayers.push(layer);
  return () => {
    const index = overlayLayers.indexOf(layer);
    if (index >= 0) overlayLayers.splice(index, 1);
  };
}

export function isTopmostBackLayer(close: () => void): boolean {
  return overlayLayers.at(-1)?.close === close;
}

export function isInsideOpenPopup(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OPEN_POPUP_SELECTOR) !== null;
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
