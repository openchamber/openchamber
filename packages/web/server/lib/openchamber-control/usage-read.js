
import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';

const LIST_TIMEOUT_MS = 10_000;
const PROVIDER_TIMEOUT_MS = 30_000;

const TIMED_OUT = Symbol('timed out');

const withDeadline = (promise, timeoutMs) => {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

const untilAborted = (promise, signal) => {
  if (!signal) return promise;
  const cancelled = () => new OpenChamberControlError('OpenChamber action was cancelled', 499);
  if (signal.aborted) return Promise.reject(cancelled());
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
};

const seconds = (milliseconds) => Math.round(milliseconds / 1000);

const withoutAccount = ({ accountLabel: _accountLabel, ...result }) => result;

/**
 * @param {object} options
 * @param {() => Promise<object | null>} options.readSettings
 * @param {() => Promise<{ listUsagePageProviders: Function, listConfiguredQuotaProviders: Function, fetchQuotaForProvider: Function }>} options.loadQuota
 * @param {number} [options.listTimeoutMs]
 * @param {number} [options.providerTimeoutMs]
 */
export const createUsageReadAction = ({
  readSettings,
  loadQuota,
  listTimeoutMs = LIST_TIMEOUT_MS,
  providerTimeoutMs = PROVIDER_TIMEOUT_MS,
}) => {
  const failedRead = ({ providerId, providerName }, error) => ({
    providerId,
    providerName,
    ok: false,
    configured: true,
    usage: null,
    fetchedAt: Date.now(),
    error,
  });

  const readProvider = async (quota, provider) => {
    try {
      const result = await withDeadline(quota.fetchQuotaForProvider(provider.providerId), providerTimeoutMs);
      if (result === TIMED_OUT) return failedRead(provider, `No answer within ${seconds(providerTimeoutMs)} seconds`);
      return withoutAccount(result);
    } catch (error) {
      return failedRead(provider, error instanceof Error ? error.message : 'Request failed');
    }
  };

  const readAll = async (quota, known) => {
    const listed = await withDeadline(
      Promise.resolve().then(() => quota.listConfiguredQuotaProviders()).then((ids) => ({ ids }), (error) => ({ error })),
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

  return async (input = {}, { signal } = {}) => {
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
