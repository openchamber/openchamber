import { useAppLinkTrustStore } from '@/stores/appLinkTrustStore';
import { getUrlScheme, openConfirmedAppLinkUrl } from '@/lib/url';

export type AppLinkConfirmationChoice = 'open' | 'trust' | 'cancel';

type PendingAppLinkRequest = {
  url: string;
  resolve: (choice: AppLinkConfirmationChoice) => void;
};

let pendingRequest: PendingAppLinkRequest | null = null;
const listeners = new Set<() => void>();

const emitChange = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

const getSnapshot = (): PendingAppLinkRequest | null => pendingRequest;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const openAppLinkWithConfirmation = (url: string): Promise<void> => {
  const scheme = getUrlScheme(url);
  if (!scheme) {
    return Promise.resolve();
  }

  const trustStore = useAppLinkTrustStore.getState();
  if (trustStore.isSchemeTrusted(scheme)) {
    return openConfirmedAppLinkUrl(url).then(() => undefined);
  }

  if (pendingRequest) {
    pendingRequest.resolve('cancel');
  }

  return new Promise<AppLinkConfirmationChoice>((resolve) => {
    pendingRequest = { url, resolve };
    emitChange();
  }).then((choice) => {
    if (choice === 'trust') {
      useAppLinkTrustStore.getState().trustScheme(scheme);
    }
    if (choice === 'open' || choice === 'trust') {
      return openConfirmedAppLinkUrl(url).then(() => undefined);
    }
  });
};

export const settleAppLinkConfirmation = (choice: AppLinkConfirmationChoice): void => {
  const request = pendingRequest;
  pendingRequest = null;
  emitChange();
  request?.resolve(choice);
};

export const subscribeAppLinkConfirmation = subscribe;
export const getAppLinkConfirmationSnapshot = getSnapshot;
