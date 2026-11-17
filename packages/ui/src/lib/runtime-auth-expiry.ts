import { create } from 'zustand';


export type AuthSessionState = 'ok' | 'expired' | 'reauthenticating';

interface AuthSessionStore {
  state: AuthSessionState;
  markExpired: () => void;
  markReauthenticating: () => void;
  markAuthenticated: () => void;
}

export const useAuthSessionStore = create<AuthSessionStore>((set) => ({
  state: 'ok',
  markExpired: () => set((current) => (current.state === 'expired' ? current : { state: 'expired' })),
  markReauthenticating: () => set({ state: 'reauthenticating' }),
  markAuthenticated: () => set({ state: 'ok' }),
}));

export const waitForAuthSession = (signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted || useAuthSessionStore.getState().state === 'ok') {
    resolve();
    return;
  }
  const finish = () => {
    unsubscribe();
    signal.removeEventListener('abort', finish);
    resolve();
  };
  const unsubscribe = useAuthSessionStore.subscribe((store) => {
    if (store.state === 'ok') finish();
  });
  signal.addEventListener('abort', finish, { once: true });
});

const CONFIRM_PROBE_MIN_INTERVAL_MS = 15_000;
const FOCUS_REVALIDATE_MIN_INTERVAL_MS = 5 * 60_000;

let lastProbeAt = 0;
let probeInFlight = false;

const isExcludedAuthPath = (url: string): boolean => (
  url.includes('/auth/session') || url.includes('/api/client-auth/')
);

const isClassifiablePath = (url: string): boolean => {
  const path = url.startsWith('/') ? url : (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  })();
  if (!path.startsWith('/api/') && !path.startsWith('/auth/')) return false;
  return !isExcludedAuthPath(path);
};

const confirmSessionExpired = async (): Promise<void> => {
  if (probeInFlight) return;
  probeInFlight = true;
  try {
    const { runtimeFetch } = await import('./runtime-fetch');
    const response = await runtimeFetch('/auth/session', { credentials: 'include' });
    if (response.status === 401) {
      useAuthSessionStore.getState().markExpired();
      return;
    }
    if (response.ok) {
      const { state, markAuthenticated } = useAuthSessionStore.getState();
      if (state === 'expired') markAuthenticated();
    }
  } catch {
    // Transport failure is connectivity, not authentication; the connection
    // status machinery owns that story.
  } finally {
    probeInFlight = false;
  }
};

export const observeRuntimeAuthResponse = (url: string, status: number): void => {
  if (status !== 401) return;
  if (useAuthSessionStore.getState().state === 'expired') return;
  if (!isClassifiablePath(url)) return;
  const now = Date.now();
  if (now - lastProbeAt < CONFIRM_PROBE_MIN_INTERVAL_MS) return;
  lastProbeAt = now;
  void confirmSessionExpired();
};

let watchInstalled = false;

export const installAuthSessionFocusWatch = (): void => {
  if (watchInstalled) return;
  watchInstalled = true;
  let lastConfirmedAt = Date.now();
  const revalidate = () => {
    if (useAuthSessionStore.getState().state !== 'ok') return;
    const now = Date.now();
    if (now - lastConfirmedAt < FOCUS_REVALIDATE_MIN_INTERVAL_MS) return;
    lastConfirmedAt = now;
    lastProbeAt = now;
    void confirmSessionExpired();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') revalidate();
  });
  window.addEventListener('focus', revalidate);
};
