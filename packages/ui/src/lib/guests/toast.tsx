import React from 'react';
import type { ToastRequest } from '@openchamber/sdk';
import { toast, type ExternalToast } from 'sonner';

import { GuestToastActions } from '@/components/layout/GuestToastActions';
import { generateUuid } from '@/lib/uuid';

const TOAST_WINDOW_MS = 10_000;
const TOASTS_PER_WINDOW = 5;
const recentToasts = new Map<string, number[]>();

/** An extension in a loop cannot bury the app; the rest of a burst is dropped. */
export const allowGuestToast = (guestId: string, now: number): boolean => {
  const recent = (recentToasts.get(guestId) ?? []).filter((at) => now - at < TOAST_WINDOW_MS);
  const allowed = recent.length < TOASTS_PER_WINDOW;
  recentToasts.set(guestId, allowed ? [...recent, now] : recent);
  return allowed;
};

/** Buttons own only local toast data and remain usable after the guest frame exits. */
export const showGuestToast = (request: ToastRequest, guestId: string): void => {
  if (!allowGuestToast(guestId, Date.now())) return;
  const copyText = request.copy === true ? request.message : request.copy ? request.copy.text : undefined;
  const dismiss = request.dismiss === true || request.persistent === true;
  if (copyText === undefined && !dismiss) {
    toast[request.kind](request.message);
    return;
  }
  const id = generateUuid();
  const options: ExternalToast = {
    id,
    action: <GuestToastActions copyText={copyText} dismiss={dismiss} onDismiss={() => toast.dismiss(id)} />,
  };
  if (request.persistent) options.duration = Infinity;
  toast[request.kind](request.message, options);
};
