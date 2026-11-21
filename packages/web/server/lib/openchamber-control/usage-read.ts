
import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';
import type * as quotaModule from '../quota/index.js';
import type { ActionContext } from './contracts.js';

export interface UsageInput {
  providerId?: unknown;
}

type Quota = Pick<typeof quotaModule, 'listUsagePageProviders' | 'listConfiguredQuotaProviders' | 'fetchQuotaForProvider'>;
type UsageProvider = ReturnType<Quota['listUsagePageProviders']>[number];
type QuotaResult = Awaited<ReturnType<Quota['fetchQuotaForProvider']>>;

export interface UsageReadDependencies {
  readSettings: () => Promise<{ agentUsageToolEnabled?: unknown } | null>;
  loadQuota: () => Promise<Quota>;
  listTimeoutMs?: number;
  providerTimeoutMs?: number;
}

const LIST_TIMEOUT_MS = 10_000;
const PROVIDER_TIMEOUT_MS = 30_000;

const TIMED_OUT = Symbol('timed out');

const withDeadline = <Value>(promise: Promise<Value>, timeoutMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

const untilAborted = <Value>(promise: Promise<Value>, signal: AbortSignal | undefined) => {
  if (!signal) return promise;
  const cancelled = () => new OpenChamberControlError('OpenChamber action was cancelled', 499);
  if (signal.aborted) return Promise.reject(cancelled());
  let rejectAbort: (reason: OpenChamberControlError) => void;
  const onAbort = () => rejectAbort(cancelled());
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
};

const seconds = (milliseconds: number) => Math.round(milliseconds / 1000);

const withoutAccount = ({ accountLabel: _accountLabel, ...result }: QuotaResult) => result;

export const createUsageReadAction = ({
  readSettings,
  loadQuota,
  listTimeoutMs = LIST_TIMEOUT_MS,
  providerTimeoutMs = PROVIDER_TIMEOUT_MS,
}: UsageReadDependencies) => {
  const failedRead = ({ providerId, providerName }: UsageProvider, error: string) => ({
    providerId,
    providerName,
    ok: false,
    configured: true,
    usage: null,
    fetchedAt: Date.now(),
    error,
  });

  const readProvider = async (quota: Quota, provider: UsageProvider) => {
    try {
      const result = await withDeadline(quota.fetchQuotaForProvider(provider.providerId), providerTimeoutMs);
      if (result === TIMED_OUT) return failedRead(provider, `No answer within ${seconds(providerTimeoutMs)} seconds`);
      return withoutAccount(result);
    } catch (error) {
      return failedRead(provider, error instanceof Error ? error.message : 'Request failed');
    }
  };

  const readAll = async (quota: Quota, known: UsageProvider[]) => {
    const listed = await withDeadline(
      Promise.resolve().then(() => quota.listConfiguredQuotaProviders()).then((ids) => ({ ids, error: undefined }), (error) => ({ error, ids: undefined })),
      listTimeoutMs,
    );
    if (listed === TIMED_OUT || listed.error) {
      const listError = listed === TIMED_OUT
        ? `OpenCode did not say which providers are configured within ${seconds(listTimeoutMs)} seconds, so every provider was asked`
        : `Could not read which providers are configured (${listed.error instanceof Error ? listed.error.message : 'unknown error'}), so every provider was asked`;
      return { providers: await Promise.all(known.map((provider) => readProvider(quota, provider))), listError };
    }
    const configured = new Set(listed.ids);
    return {
      providers: await Promise.all(known.filter(({ providerId }) => configured.has(providerId)).map((provider) => readProvider(quota, provider))),
      notConfigured: known.filter(({ providerId }) => !configured.has(providerId)).map(({ providerId }) => providerId),
    };
  };

  return async (input: UsageInput = {}, { signal }: ActionContext = {}) => {
    const settings = await readSettings().catch(() => null);
    if (settings?.agentUsageToolEnabled !== true) {
      throw new OpenChamberControlError('The usage tool is turned off in OpenChamber settings', 403);
    }
    const quota = await loadQuota();
    const known = quota.listUsagePageProviders();
    const providerId = asNonEmptyString(input.providerId);
    if (!providerId) return untilAborted(readAll(quota, known), signal);

    const provider = known.find((entry) => entry.providerId === providerId);
    if (!provider) {
      throw new OpenChamberControlError(`Unknown providerId: ${providerId}. Use one of: ${known.map((entry) => entry.providerId).join(', ')}`, 400);
    }
    return untilAborted(readProvider(quota, provider).then((result) => ({ providers: [result] })), signal);
  };
};
