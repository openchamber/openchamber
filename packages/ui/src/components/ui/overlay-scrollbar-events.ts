export const OVERLAY_SCROLLBAR_CANCEL_SCROLL_EVENT = 'openchamber:overlay-scrollbar-cancel-scroll';

export const cancelOverlayScrollbarScroll = (container: HTMLElement | null | undefined): void => {
  container?.dispatchEvent(new Event(OVERLAY_SCROLLBAR_CANCEL_SCROLL_EVENT));
};
