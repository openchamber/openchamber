import { runtimeFetch } from '@/lib/runtime-fetch';

export type WebUpdateTransactionState =
  | 'prepared'
  | 'waiting-for-server-exit'
  | 'installing'
  | 'verifying'
  | 'rolling-back'
  | 'restarting'
  | 'awaiting-service-restart'
  | 'checking-health'
  | 'healthy'
  | 'recovered-old-version'
  | 'failed';

export type WebUpdateTransactionStatus = {
  id: string;
  state: WebUpdateTransactionState;
  currentVersion: string;
  targetVersion: string;
  installedVersion?: string;
  errorCode?: string;
  error?: string;
};

export type StartWebUpdateResult =
  | {
      accepted: true;
      transactionId: string;
      currentVersion: string;
      targetVersion: string;
      restartManager: 'cli' | 'service';
    }
  | {
      accepted: false;
      error?: string;
    };

export type WaitForWebUpdateResult =
  | { outcome: 'healthy' }
  | { outcome: 'recovered-old-version'; errorCode?: string }
  | { outcome: 'failed'; errorCode?: string }
  | { outcome: 'timeout' };

type RuntimeFetcher = typeof runtimeFetch;

const WEB_UPDATE_POLL_INTERVAL_MS = 2000;
const WEB_UPDATE_MAX_WAIT_MS = 50 * 60 * 1000;
const WEB_UPDATE_STATES: ReadonlySet<WebUpdateTransactionState> = new Set([
  'prepared',
  'waiting-for-server-exit',
  'installing',
  'verifying',
  'rolling-back',
  'restarting',
  'awaiting-service-restart',
  'checking-health',
  'healthy',
  'recovered-old-version',
  'failed',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);
const isWebUpdateTransactionState = (value: unknown): value is WebUpdateTransactionState => (
  typeof value === 'string' && WEB_UPDATE_STATES.has(value as WebUpdateTransactionState)
);

export async function startWebUpdate(fetcher: RuntimeFetcher = runtimeFetch): Promise<StartWebUpdateResult> {
  try {
    const response = await fetcher('/api/openchamber/update-install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { accepted: false, error: data.error || `Server error: ${response.status}` };
    }
    if (
      data.accepted !== true
      || typeof data.transactionId !== 'string'
      || typeof data.currentVersion !== 'string'
      || typeof data.targetVersion !== 'string'
    ) {
      return { accepted: false, error: 'Invalid update transaction response' };
    }
    return {
      accepted: true,
      transactionId: data.transactionId,
      currentVersion: data.currentVersion,
      targetVersion: data.targetVersion,
      restartManager: data.restartManager === 'service' ? 'service' : 'cli',
    };
  } catch (error) {
    return { accepted: false, error: error instanceof Error ? error.message : undefined };
  }
}

async function readHealthyVersion(fetcher: RuntimeFetcher): Promise<string | null> {
  try {
    const response = await fetcher('/health', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return typeof data?.openchamberVersion === 'string' ? data.openchamberVersion : null;
  } catch {
    return null;
  }
}

async function readTransactionStatus(
  fetcher: RuntimeFetcher,
  transactionId: string,
): Promise<WebUpdateTransactionStatus | null> {
  try {
    const response = await fetcher(`/api/openchamber/update-status/${encodeURIComponent(transactionId)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (
      !isRecord(data)
      || data.id !== transactionId
      || !isWebUpdateTransactionState(data.state)
      || typeof data.currentVersion !== 'string'
      || typeof data.targetVersion !== 'string'
    ) return null;
    return {
      id: data.id,
      state: data.state,
      currentVersion: data.currentVersion,
      targetVersion: data.targetVersion,
      ...(typeof data.installedVersion === 'string' ? { installedVersion: data.installedVersion } : {}),
      ...(typeof data.errorCode === 'string' ? { errorCode: data.errorCode } : {}),
      ...(typeof data.error === 'string' ? { error: data.error } : {}),
    };
  } catch {
    return null;
  }
}

export async function waitForWebUpdate(options: {
  transactionId: string;
  targetVersion: string;
  fetcher?: RuntimeFetcher;
  maxAttempts?: number;
  intervalMs?: number;
  onStatus?: (status: WebUpdateTransactionStatus) => void;
}): Promise<WaitForWebUpdateResult> {
  const {
    transactionId,
    targetVersion,
    fetcher = runtimeFetch,
    maxAttempts = Math.ceil(WEB_UPDATE_MAX_WAIT_MS / WEB_UPDATE_POLL_INTERVAL_MS),
    intervalMs = WEB_UPDATE_POLL_INTERVAL_MS,
    onStatus,
  } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await readHealthyVersion(fetcher) === targetVersion) {
      return { outcome: 'healthy' };
    }

    const status = await readTransactionStatus(fetcher, transactionId);
    if (status) {
      onStatus?.(status);
      if (status.state === 'recovered-old-version') {
        return { outcome: 'recovered-old-version', errorCode: status.errorCode };
      }
      if (status.state === 'failed') {
        return { outcome: 'failed', errorCode: status.errorCode };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { outcome: 'timeout' };
}
