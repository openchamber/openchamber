import { invalidateSettingsCache, loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import type { Metadata, Session } from '@/lib/opencode/model';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { isPinnedMetadata, withSessionPinned } from '@/lib/sessionPins';
import { isSessionInWork, withSessionWorkClosed, withSessionWorkState, type SessionWork } from '@/lib/sessionWorkMetadata';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

export const keepsPinnedOutOfWork = async (): Promise<boolean> => {
  const isCurrentRuntime = captureRuntimeInstance();
  invalidateSettingsCache();
  const settings = await loadDesktopSettings();
  if (!settings || !isCurrentRuntime()) return false;
  const pinnedInWork = settings.sessionWorkIncludesPinned === true;
  if (useSessionDisplayStore.getState().pinnedInWork !== pinnedInWork) useSessionDisplayStore.setState({ pinnedInWork });
  return !pinnedInWork;
};

export const setPinnedInWork = async (pinnedInWork: boolean): Promise<void> => {
  const isCurrentRuntime = captureRuntimeInstance();
  if (pinnedInWork) useSessionDisplayStore.setState({ pinnedInWork });
  const { ok } = await updateDesktopSettings({ sessionWorkIncludesPinned: pinnedInWork });
  if (isCurrentRuntime()) useSessionDisplayStore.setState({ pinnedInWork: ok ? pinnedInWork : !pinnedInWork });
};

export const closesWorkOnPin = async (session: Session | null): Promise<boolean> => isSessionInWork(session) && await keepsPinnedOutOfWork();

export const withSessionPinChange = (
  metadata: Metadata,
  { pinned, list, closesWork, now }: { pinned: boolean; list: string | null; closesWork: boolean; now: number },
): Metadata => {
  const next = withSessionPinned(metadata, pinned, now, list);
  return closesWork ? withSessionWorkClosed(next, now) : next;
};

export const withUserWorkState = (metadata: Metadata, state: SessionWork['state'], now: number): Metadata => (
  state === 'open' && !useSessionDisplayStore.getState().pinnedInWork && isPinnedMetadata(metadata)
    ? metadata
    : withSessionWorkState(metadata, state, now)
);
