/**
 * Where each zone header's live content is: in its slot in the list, or moved
 * into the pinned layer while the header sticks to the top
 * (`CrossfadeZoneHeaders`). A copy of a row drawn as the user sees it takes a
 * stuck header's content from the layer.
 */
const hostBySlot = new WeakMap<Element, Element>();

export const ZONE_HEADER_SLOT_ATTRIBUTE = 'data-zone-header-slot';

export const registerZoneHeaderHost = (slot: Element, host: Element): (() => void) => {
  hostBySlot.set(slot, host);
  return () => {
    hostBySlot.delete(slot);
  };
};

/** Fills the slots in `copy` whose header sticks, from the original's live content. */
export const fillStuckZoneHeaders = (original: Element, copy: Element): void => {
  const selector = `[${ZONE_HEADER_SLOT_ATTRIBUTE}]`;
  const copies = copy.querySelectorAll(selector);
  original.querySelectorAll(selector).forEach((slot, index) => {
    const host = hostBySlot.get(slot);
    if (host && !slot.contains(host)) copies[index]?.replaceChildren(host.cloneNode(true));
  });
};
