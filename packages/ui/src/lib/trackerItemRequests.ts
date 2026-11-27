import type { BrowserHandoff } from '@/lib/router/notificationNavigation';

type TrackerItemRequest = { url: string; directory: string | null; loadedTab?: boolean };
type PendingTrackerItemRequest = TrackerItemRequest & { handoff: BrowserHandoff | undefined };

let pending: PendingTrackerItemRequest | null = null;
const listeners = new Set<() => void>();

export const requestTrackerItemOpen = (request: TrackerItemRequest, handoff?: BrowserHandoff): void => {
  const url = request.url.trim();
  if (!url) {
    handoff?.release();
    return;
  }
  pending?.handoff?.release();
  pending = { url, directory: request.directory?.trim() || null, loadedTab: request.loadedTab === true, handoff };
  for (const listener of listeners) listener();
};

export const subscribeTrackerItemRequests = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const readTrackerItemRequest = (): PendingTrackerItemRequest | null => pending;

export const takeTrackerItemRequest = (request: PendingTrackerItemRequest): boolean => {
  if (pending !== request) return false;
  pending = null;
  return true;
};
