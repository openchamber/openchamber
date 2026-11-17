import type { AppRouteState } from './serializeRoute';

const BACK_GUARD_KEY = '__openchamberBackGuard';

type BackGuardState = { [BACK_GUARD_KEY]?: boolean };

export function isBackGuardEntry(): boolean {
  const state: BackGuardState | null = window.history.state;
  return state?.[BACK_GUARD_KEY] === true;
}

export function pushBackGuard(): void {
  window.history.pushState({ [BACK_GUARD_KEY]: true }, '');
}

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
