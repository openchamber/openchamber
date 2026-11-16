const hostBySlot = new WeakMap<Element, Element>();

export const ZONE_HEADER_SLOT_ATTRIBUTE = 'data-zone-header-slot';

export const registerZoneHeaderHost = (slot: Element, host: Element): (() => void) => {
  hostBySlot.set(slot, host);
  return () => {
    hostBySlot.delete(slot);
  };
};

export const fillStuckZoneHeaders = (original: Element, copy: Element): void => {
  const selector = `[${ZONE_HEADER_SLOT_ATTRIBUTE}]`;
  const copies = copy.querySelectorAll(selector);
  original.querySelectorAll(selector).forEach((slot, index) => {
    const host = hostBySlot.get(slot);
    if (host && !slot.contains(host)) copies[index]?.replaceChildren(host.cloneNode(true));
  });
};
