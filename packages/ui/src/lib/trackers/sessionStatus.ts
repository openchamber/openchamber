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

/**
 * Origin a tracker's session comment should open. Packaged desktop UI lives
 * on `openchamber-ui://`, which is not a URL a browser can load from the
 * tracker, so report the http origin the local server actually listens on
 * instead. The server decides whether that origin is reachable by anyone
 * else; a comment is only posted when it is.
 */
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

// How long a session start waits for the tracker list before it is not reported.
const SESSION_START_LIST_WAIT_MS = 2 * 60_000;

/**
 * Tells the tracker a session started from one of its items, for a tracker
 * that posts session comments. Fire and forget: the server decides whether a
 * comment is posted (turned on, public origin) and a failure changes nothing
 * here. Which trackers post comments is the registry's answer, so a session
 * started before that answer arrives waits for it (bounded) instead of being
 * skipped as if the tracker had none; a runtime switch meanwhile drops it.
 */
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
