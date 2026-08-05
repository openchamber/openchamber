import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * Web-runtime update completion logic for `UpdateDialog`.
 *
 * Extracted from `UpdateDialog.tsx` so the wait-for-apply decision can be
 * unit-tested without a DOM, timers, or network. The dialog remains the sole
 * owner of UI state (progress text, reload, error rendering).
 *
 * Why this exists: the old flow polled `/update-check` and treated any
 * `available === false` answer as "the update is applied". That is wrong —
 * `checkForUpdates` reports `available: false` for check failures too (npm
 * registry unreachable, or the install window where `package.json` is missing
 * from disk and the version is `'unknown'`). The UI then reloaded while the
 * detached `npm install` was still running or had failed, and the update
 * button reappeared. The server now records authoritative install state
 * (`/api/openchamber/update-status`); this module waits on that state first
 * and only falls back to version-move detection when the endpoint is missing
 * or unreachable (older server, server restarting).
 *
 * Exposed for unit testing. Not part of the stable consumer surface.
 */

export type WebUpdateStatusState = 'installing' | 'success' | 'failed' | 'idle';

export interface WebUpdateStatusPayload {
  state: WebUpdateStatusState;
  exitCode?: number;
}

export type WebUpdateCheckResult =
  | { kind: 'ok'; available: boolean; currentVersion: string | undefined }
  | { kind: 'unauthorized' }
  | { kind: 'unavailable' };

export type WebUpdateWaitResult =
  | { outcome: 'applied' }
  | { outcome: 'failed'; exitCode?: number }
  | { outcome: 'timeout' };

export interface WebUpdateWaitOptions {
  /** Version reported by the server when the dialog opened. */
  previousVersion: string | undefined;
  /** Version the install is expected to deliver. */
  targetVersion: string | undefined;
  fetchStatus?: () => Promise<WebUpdateStatusPayload | null>;
  fetchCheck?: () => Promise<WebUpdateCheckResult>;
  isServerReachable?: () => Promise<boolean>;
  maxAttempts?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const WEB_UPDATE_POLL_INTERVAL_MS = 2000;
const WEB_UPDATE_MAX_WAIT_MS = 10 * 60 * 1000;

const sleepDefault = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * True when the server's reported current version proves the install landed:
 * either it reached the exact target version, or it moved off the previous
 * version to any known version (npm may deliver a newer patch than the API
 * advertised). An `'unknown'` current version never counts — it is the
 * transient state while the package directory is being replaced.
 */
const versionMovedToTarget = (
  currentVersion: string | undefined,
  previousVersion: string | undefined,
  targetVersion: string | undefined,
): boolean => {
  if (typeof currentVersion !== 'string' || currentVersion.length === 0) {
    return false;
  }
  if (typeof targetVersion === 'string' && targetVersion.length > 0 && currentVersion === targetVersion) {
    return true;
  }
  return typeof previousVersion === 'string'
    && previousVersion.length > 0
    && currentVersion !== previousVersion
    && currentVersion !== 'unknown';
};

export const waitForWebUpdateApplied = async (options: WebUpdateWaitOptions): Promise<WebUpdateWaitResult> => {
  const {
    previousVersion,
    targetVersion,
    fetchStatus = fetchWebUpdateStatus,
    fetchCheck = fetchWebUpdateCheck,
    isServerReachable: isServerReachableFn = isServerReachable,
    maxAttempts = Math.ceil(WEB_UPDATE_MAX_WAIT_MS / WEB_UPDATE_POLL_INTERVAL_MS),
    intervalMs = WEB_UPDATE_POLL_INTERVAL_MS,
    sleep = sleepDefault,
  } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await fetchStatus();
    if (status) {
      if (status.state === 'success') {
        return { outcome: 'applied' };
      }
      if (status.state === 'failed') {
        return {
          outcome: 'failed',
          ...(typeof status.exitCode === 'number' ? { exitCode: status.exitCode } : {}),
        };
      }
      // 'installing' (and 'idle' for an erased file) → keep polling.
    } else {
      // Status endpoint unreachable: server restarting, or an older server
      // without the route. Fall back to version-move detection only — a
      // "no update available" answer without a version change is a check
      // failure, not proof that the install finished.
      const check = await fetchCheck();
      if (check.kind === 'ok') {
        if (versionMovedToTarget(check.currentVersion, previousVersion, targetVersion)) {
          return { outcome: 'applied' };
        }
      } else if (check.kind === 'unauthorized' && await isServerReachableFn()) {
        // Server restarted behind auth: the reload will re-authenticate.
        return { outcome: 'applied' };
      }
    }
    await sleep(intervalMs);
  }

  return { outcome: 'timeout' };
};

/**
 * Reads the server's authoritative install state. Returns `null` when the
 * endpoint is missing (older server) or unreachable (server restarting) so
 * callers fall back to version-move detection.
 */
export const fetchWebUpdateStatus = async (): Promise<WebUpdateStatusPayload | null> => {
  try {
    const response = await runtimeFetch('/api/openchamber/update-status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data.state !== 'string') {
      return null;
    }
    if (data.state !== 'installing' && data.state !== 'success' && data.state !== 'failed' && data.state !== 'idle') {
      return null;
    }
    return {
      state: data.state,
      ...(typeof data.exitCode === 'number' ? { exitCode: data.exitCode } : {}),
    };
  } catch {
    return null;
  }
};

/**
 * Status-only update check used by the version-move fallback. Never a usage
 * report; `reportUsage=false` is fixed so background polls stay silent.
 */
export const fetchWebUpdateCheck = async (): Promise<WebUpdateCheckResult> => {
  try {
    const response = await runtimeFetch('/api/openchamber/update-check?reportUsage=false', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (response.ok) {
      const data = await response.json().catch(() => null);
      return {
        kind: 'ok',
        available: data?.available === true,
        currentVersion: typeof data?.currentVersion === 'string' ? data.currentVersion : undefined,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return { kind: 'unauthorized' };
    }
    return { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
};

const isServerReachable = async (): Promise<boolean> => {
  try {
    const response = await runtimeFetch('/health', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
};
