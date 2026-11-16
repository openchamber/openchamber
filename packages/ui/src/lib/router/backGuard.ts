import type { AppRouteState } from './serializeRoute';

/**
 * The mobile web shell keeps one history entry above the page while a layer is
 * open, so Back lands in the app and closes that layer. The entry repeats the
 * URL under it and only ever sits on top of the stack. A route written while it
 * is there goes under it: a guard buried between two routes would be an empty
 * Back press later. A replacement rewrites the guard's own URL: it corrects a
 * route to what that route resolves to, and the entry under the guard resolves
 * the same way when Back reaches it.
 */
const BACK_GUARD_KEY = '__openchamberBackGuard';

type BackGuardState = { [BACK_GUARD_KEY]?: boolean };

export function isBackGuardEntry(): boolean {
  const state: BackGuardState | null = window.history.state;
  return state?.[BACK_GUARD_KEY] === true;
}

export function pushBackGuard(): void {
  window.history.pushState({ [BACK_GUARD_KEY]: true }, '');
}

export function pushRouteEntry(state: { route?: AppRouteState }, url: string): void {
  if (!isBackGuardEntry()) {
    window.history.pushState(state, '', url);
    return;
  }
  window.history.replaceState(state, '', url);
  pushBackGuard();
}
