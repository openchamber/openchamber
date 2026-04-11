import type { OpenCodeManager } from './opencode';

export const API_URL_WAIT_TIMEOUT_MS = 30000;

export async function waitForApiUrl(
  manager: OpenCodeManager | undefined,
  timeoutMs = API_URL_WAIT_TIMEOUT_MS,
): Promise<string | null> {
  if (!manager) {
    return null;
  }

  const initialUrl = manager.getApiUrl();
  if (initialUrl) {
    return initialUrl;
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let subscription: { dispose(): void } | null = null;
    let disposeAfterSubscribe = false;

    const handleStatusChange = () => {
      const nextUrl = manager.getApiUrl();
      if (!nextUrl || settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (subscription) {
        subscription.dispose();
      } else {
        disposeAfterSubscribe = true;
      }
      resolve(nextUrl);
    };

    subscription = manager.onStatusChange(handleStatusChange);
    if (disposeAfterSubscribe) {
      subscription.dispose();
      return;
    }
    if (settled) {
      return;
    }

    timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      subscription?.dispose();
      resolve(manager.getApiUrl());
    }, timeoutMs);
  });
}
