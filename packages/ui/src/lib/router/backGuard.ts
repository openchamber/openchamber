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

/**
 * The native app's dev-server preview keeps a guard of its own above the app's
 * history while it shows a page. The page's own navigations land above it in
 * the WebView's history, so Back walks them first and leaves the guard only
 * when the page has nothing left to go back to. The id tells a guard of the
 * page on screen from one an earlier page or a route write left behind.
 */
const PREVIEW_FRAME_KEY = '__openchamberPreviewFrame';

type PreviewFrameState = { [PREVIEW_FRAME_KEY]?: string };

export function pushPreviewFrameGuard(id: string): void {
  window.history.pushState({ [BACK_GUARD_KEY]: true, [PREVIEW_FRAME_KEY]: id }, '');
}

export function isPreviewFrameGuard(id: string): boolean {
  const state: PreviewFrameState | null = window.history.state;
  return state?.[PREVIEW_FRAME_KEY] === id;
}

export function pushRouteEntry(state: { route?: AppRouteState }, url: string): void {
  if (!isBackGuardEntry()) {
    window.history.pushState(state, '', url);
    return;
  }
  window.history.replaceState(state, '', url);
  pushBackGuard();
}
