import { z } from 'zod';

const navigationRequest = z.object({
  type: z.literal('openchamber:notification-navigation'),
  url: z.string().url(),
  expiresAt: z.number().finite(),
});

let acceptNavigation: ((url: URL) => boolean) | null = null;

/** Both browser notifications and worker messages use the mounted app router. */
export function navigateFromNotification(url: string): boolean {
  if (!acceptNavigation) return false;
  try {
    const target = new URL(url, window.location.origin);
    return target.origin === window.location.origin
      && target.pathname === window.location.pathname
      && acceptNavigation(target);
  } catch {
    return false;
  }
}

/** Listen only while the app router is mounted and able to accept navigation. */
export function listenForNotificationNavigation(accept: (url: URL) => boolean): () => void {
  acceptNavigation = accept;
  const serviceWorker = 'serviceWorker' in navigator ? navigator.serviceWorker : null;

  const onMessage = (event: MessageEvent<unknown>) => {
    const request = navigationRequest.safeParse(event.data);
    const port = event.ports[0];
    if (!request.success || !port) return;

    try {
      const accepted = event.origin === window.location.origin
        && Date.now() < request.data.expiresAt
        && navigateFromNotification(request.data.url);
      port.postMessage(accepted);
    } catch {
      // A synchronous routing failure must leave document fallback available.
      port.postMessage(false);
    } finally {
      port.close();
    }
  };

  serviceWorker?.addEventListener('message', onMessage);
  return () => {
    serviceWorker?.removeEventListener('message', onMessage);
    if (acceptNavigation === accept) acceptNavigation = null;
  };
}
