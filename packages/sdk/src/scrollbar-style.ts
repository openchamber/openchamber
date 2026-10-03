/**
 * Scrollbars in extension documents behave like the app's own overlay
 * scrollbars: invisible at rest, shown while the pointer is over the
 * scrolling element or while it scrolls, then hidden again after
 * one second (the app's `OverlayScrollbar` default).
 *
 * Hover works from CSS alone. "While it scrolls" needs the attribute set by
 * `installGuestScrollbarActivity`; without it (an authored CSP that blocks the
 * inline script), scrollbars still appear on hover.
 *
 * Shared by served extension documents and the UI kit, including older guest bundles.
 */
/** Attribute present on an element for a moment after it scrolled. */
const GUEST_SCROLLING_ATTRIBUTE = 'data-oc-scrolling';

export const GUEST_SCROLLBAR_CSS = `
:root {
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 40%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 65%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [${GUEST_SCROLLING_ATTRIBUTE}] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [${GUEST_SCROLLING_ATTRIBUTE}]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;

/**
 * Marks whichever element scrolls (the root for document scrolling) with
 * `GUEST_SCROLLING_ATTRIBUTE` and clears it once scrolling has been quiet for
 * the hide delay. One capturing, passive listener per document; installing
 * twice is a no-op. Self-contained on purpose: the server inlines its source.
 */
export function installGuestScrollbarActivity(doc: Document): void {
  const root = doc.documentElement;
  if (root.hasAttribute('data-oc-scrollbar-activity')) return;
  root.setAttribute('data-oc-scrollbar-activity', '');
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  doc.addEventListener('scroll', (event) => {
    const target = event.target === doc ? root : event.target;
    if (!(target instanceof Element)) return;
    if (!target.hasAttribute('data-oc-scrolling')) target.setAttribute('data-oc-scrolling', '');
    const pending = timers.get(target);
    if (pending !== undefined) clearTimeout(pending);
    timers.set(target, setTimeout(() => {
      timers.delete(target);
      target.removeAttribute('data-oc-scrolling');
    }, 1000));
  }, { capture: true, passive: true });
}

/** Inline script form of `installGuestScrollbarActivity`, appended by the host to served guest HTML. */
export const GUEST_SCROLLBAR_SCRIPT = `(${installGuestScrollbarActivity.toString()})(document);`;
