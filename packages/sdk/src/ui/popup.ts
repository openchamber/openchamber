import { onOutsideClick } from './dom.ts';

const placePopup = (popup: HTMLElement, trigger: HTMLElement): void => {
  const rect = trigger.getBoundingClientRect();
  popup.style.minWidth = `${Math.round(rect.width)}px`;
  popup.style.left = `${Math.round(rect.left)}px`;
  popup.style.top = `${Math.round(rect.bottom + 4)}px`;
  const height = popup.offsetHeight;
  const roomBelow = window.innerHeight - rect.bottom - 8;
  if (height > roomBelow && rect.top - 8 > roomBelow) {
    popup.style.top = `${Math.max(8, Math.round(rect.top - 4 - height))}px`;
  }
  const overflow = rect.left + popup.offsetWidth - window.innerWidth + 8;
  if (overflow > 0) {
    popup.style.left = `${Math.max(8, Math.round(rect.left - overflow))}px`;
  }
};

export const openPopup = (
  host: Element,
  trigger: HTMLElement,
  popup: HTMLElement,
  close: () => void,
): (() => void) => {
  host.append(popup);
  placePopup(popup, trigger);
  const stopOutside = onOutsideClick(host, close);
  const onResize = (): void => {
    close();
  };
  const onScroll = (event: Event): void => {
    if (event.target instanceof Node && popup.contains(event.target)) {
      return;
    }
    close();
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onScroll, true);
  return () => {
    stopOutside();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onScroll, true);
    popup.remove();
  };
};
