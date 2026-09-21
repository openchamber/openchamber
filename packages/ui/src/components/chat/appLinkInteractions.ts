import { isAppLinkUrl, isExternalHttpUrl } from '@/lib/url';

type AppLinkInteractionOptions = {
  allowExternalHttp: boolean;
  openAppLink: (url: string) => void;
  openExternalHttp: (url: string) => void;
};

type LinkInteractionContainer = {
  addEventListener: (type: string, listener: (event: MouseEvent) => void) => void;
  removeEventListener: (type: string, listener: (event: MouseEvent) => void) => void;
};

const findLink = (event: MouseEvent | DragEvent): HTMLAnchorElement | null => {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.getAttribute('data-openchamber-file-link') === 'true') return null;
  return anchor;
};

const interceptAppLink = (
  event: MouseEvent | DragEvent,
  openAppLink?: (url: string) => void,
): boolean => {
  if (event.defaultPrevented) return false;
  const anchor = findLink(event);
  const href = anchor?.getAttribute('href') ?? '';
  if (!isAppLinkUrl(href)) return false;

  event.preventDefault();
  event.stopPropagation();
  openAppLink?.(href);
  return true;
};

const isPlainPrimaryClick = (event: MouseEvent): boolean => (
  event.button === 0
  && !event.metaKey
  && !event.ctrlKey
  && !event.altKey
  && !event.shiftKey
);

export const attachAppLinkInteractions = (
  container: LinkInteractionContainer,
  options: AppLinkInteractionOptions,
): (() => void) => {
  const handleClick = (event: MouseEvent) => {
    if (interceptAppLink(event, options.openAppLink)) return;
    if (!options.allowExternalHttp || event.defaultPrevented || !isPlainPrimaryClick(event)) return;

    const href = findLink(event)?.getAttribute('href') ?? '';
    if (!isExternalHttpUrl(href)) return;
    event.preventDefault();
    event.stopPropagation();
    options.openExternalHttp(href);
  };
  const handleAuxClick = (event: MouseEvent) => {
    if (event.button === 1) interceptAppLink(event, options.openAppLink);
  };
  const blockAlternateAppLinkActivation = (event: MouseEvent | DragEvent) => {
    interceptAppLink(event);
  };

  container.addEventListener('click', handleClick);
  container.addEventListener('auxclick', handleAuxClick);
  container.addEventListener('dragstart', blockAlternateAppLinkActivation);
  return () => {
    container.removeEventListener('click', handleClick);
    container.removeEventListener('auxclick', handleAuxClick);
    container.removeEventListener('dragstart', blockAlternateAppLinkActivation);
  };
};
