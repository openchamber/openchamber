import type { ConnectionStatus, OpenCodeManager } from './opencode';

const API_URL_WAIT_TIMEOUT_MS = 30000;

export async function waitForApiUrl(
  manager: OpenCodeManager | undefined,
  timeoutMs = API_URL_WAIT_TIMEOUT_MS,
): Promise<string | null> {
  if (!manager) {
    return null;
  }

  const readyUrl = (): string | null => {
    if (manager.getStatus() !== 'connected') {
      return null;
    }
    return manager.getApiUrl();
  };

  const initialUrl = readyUrl();
  if (initialUrl) {
    return initialUrl;
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let subscription: { dispose(): void } | null = null;
    let disposeAfterSubscribe = false;

    const finish = (value: string | null) => {
      if (settled) {
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
      resolve(value);
    };

    const handleStatusChange = (status: ConnectionStatus) => {
      if (status === 'error') {
        finish(null);
        return;
      }
      const nextUrl = readyUrl();
      if (nextUrl) {
        finish(nextUrl);
      }
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
      finish(manager.getApiUrl());
    }, timeoutMs);
  });
}
