import { SpacesRequestError } from './spaces-api';

type RootStartConfirmation = { readonly spaceId: string };
let pending: { readonly request: RootStartConfirmation; readonly resolve: (accepted: boolean) => void } | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

export const getRootStartConfirmation = (): RootStartConfirmation | null => pending?.request ?? null;
export const subscribeRootStartConfirmation = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const settleRootStartConfirmation = (accepted: boolean): void => {
  const previous = pending;
  pending = null;
  notify();
  previous?.resolve(accepted);
};

/** One explicit root warning at a time. No challenge is requested before acceptance. */
export const confirmRootStart = (spaceId: string): Promise<boolean> => {
  if (pending) throw new SpacesRequestError('space_busy', '', 0);
  return new Promise((resolve) => {
    pending = { request: { spaceId }, resolve };
    notify();
  });
};
