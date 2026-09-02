import type { LinearAPI } from '@/lib/api/types';
import { isElectronShell } from '@/lib/desktop';
import { getLocalDesktopOrigin } from '@/lib/desktopCurrentHost';

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Origin Linear comments should open. Packaged desktop UI lives on
 * `openchamber-ui://`, which is not a URL a browser can load from Linear, so
 * report the http origin the local server actually listens on instead. The
 * server decides whether that origin is reachable by anyone else; a comment is
 * only posted when it is.
 */
export function resolveLinearSessionOrigin(): string | undefined {
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

export function postLinearSessionStarted(
  linear: LinearAPI | undefined,
  args: { sessionId: string; issueIdentifier: string },
): void {
  if (!linear?.sessionStatusPost) return;
  void linear.sessionStatusPost({
    kind: 'started',
    sessionId: args.sessionId,
    issueIdentifier: args.issueIdentifier,
    sessionOrigin: resolveLinearSessionOrigin(),
  }).catch(() => undefined);
}
