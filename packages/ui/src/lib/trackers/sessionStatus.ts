import { isElectronShell } from '@/lib/desktop';
import { getLocalDesktopOrigin } from '@/lib/desktopCurrentHost';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { readTrackerDescriptor, whenTrackerListHeld } from './registry';
import type { TrackerAPI } from './types';

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function resolveTrackerSessionOrigin(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  if (isElectronShell()) {
    const localOrigin = getLocalDesktopOrigin().trim();
    if (localOrigin && isHttpOrigin(localOrigin)) {
      return new URL(localOrigin).origin;
    }
    return undefined;
  }
  const origin = window.location.origin.trim();
  return origin || undefined;
}

const SESSION_START_LIST_WAIT_MS = 2 * 60_000;

export async function postTrackerSessionStarted(
  trackers: TrackerAPI | undefined,
  provider: string,
  args: { sessionId: string; identifier: string },
  listWaitMs = SESSION_START_LIST_WAIT_MS,
): Promise<void> {
  if (!trackers) return;
  const runtimeKey = getRuntimeKey();
  if (!(await whenTrackerListHeld(listWaitMs))) {
    console.warn(`[trackers] Session ${args.sessionId} was not reported on ${provider}: the tracker list did not load.`);
    return;
  }
  if (getRuntimeKey() !== runtimeKey) return;
  const descriptor = readTrackerDescriptor(provider);
  if (!descriptor.capabilities.sessionComments) return;
  await trackers.sessionStatusPost(descriptor.id, {
    kind: 'started',
    sessionId: args.sessionId,
    identifier: args.identifier,
    sessionOrigin: resolveTrackerSessionOrigin(),
  }).catch(() => undefined);
}
