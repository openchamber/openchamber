
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

export function hasOpenBackLayer(): boolean {
  return overlayLayers.length > 0 || isInsideOpenPopup(document.activeElement);
}

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

export function closeAllBackLayers(): void {
  [...overlayLayers].reverse().forEach((layer) => layer.close());
}
