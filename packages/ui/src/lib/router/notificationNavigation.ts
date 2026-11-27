import { z } from 'zod';

import { afterDelay } from '@/lib/timing/afterDelay';

import { ROUTE_PARAMS } from './types';

const navigationRequest = z.object({
  type: z.literal('openchamber:notification-navigation'),
  url: z.string().url(),
  expiresAt: z.number().finite(),
  canOpenWindow: z.boolean().optional(),
});

export interface BrowserHandoff {
  open: (url: string) => boolean;
  release: () => void;
}

export type NotificationNavigationReply = boolean | { type: 'open-window'; url: string };

const REPLY_MARGIN_MS = 1000;

let acceptNavigation: ((url: URL, handoff?: BrowserHandoff) => boolean) | null = null;

export function navigateFromNotification(url: string, handoff?: BrowserHandoff): boolean {
  if (!acceptNavigation) return false;
  try {
    const target = new URL(url, window.location.origin);
    return target.origin === window.location.origin
      && target.pathname === window.location.pathname
      && (handoff ? acceptNavigation(target, handoff) : acceptNavigation(target));
  } catch {
    return false;
  }
}

export function listenForNotificationNavigation(accept: (url: URL, handoff?: BrowserHandoff) => boolean): () => void {
  acceptNavigation = accept;
  const serviceWorker = 'serviceWorker' in navigator ? navigator.serviceWorker : null;

  const onMessage = (event: MessageEvent<unknown>) => {
    const request = navigationRequest.safeParse(event.data);
    const port = event.ports[0];
    if (!request.success || !port) return;

    let answered = false;
    let cancelDeadline: (() => void) | null = null;
    const answer = (reply: NotificationNavigationReply) => {
      if (answered) return false;
      answered = true;
      cancelDeadline?.();
      try {
        port.postMessage(reply);
      } finally {
        port.close();
      }
      return true;
    };
    const canOpenWindow = request.data.canOpenWindow === true;
    const handoff: BrowserHandoff = {
      open: (url) => canOpenWindow && answer({ type: 'open-window', url }),
      release: () => { answer(true); },
    };

    let accepted = false;
    try {
      accepted = event.origin === window.location.origin
        && Date.now() < request.data.expiresAt
        && navigateFromNotification(request.data.url, handoff);
    } catch {
      accepted = false;
    }
    if (!accepted) {
      answer(false);
      return;
    }
    if (!canOpenWindow || !new URL(request.data.url).searchParams.has(ROUTE_PARAMS.ITEM)) {
      answer(true);
      return;
    }
    cancelDeadline = afterDelay(Math.max(0, request.data.expiresAt - Date.now() - REPLY_MARGIN_MS), () => answer(true));
  };

  serviceWorker?.addEventListener('message', onMessage);
  return () => {
    serviceWorker?.removeEventListener('message', onMessage);
    if (acceptNavigation === accept) acceptNavigation = null;
  };
}
