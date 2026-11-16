/**
 * `usage.read`: the provider quotas Settings > Usage shows, for an agent that
 * wants to check a limit before a large task or report on it from a
 * scheduled task.
 *
 * It runs the same readers the Usage page runs when it loads, in the same
 * order: one read of which providers have a credential, then one read per
 * configured provider. Nothing is cached here; the readers' own protections
 * still apply (concurrent reads of one provider share a request, Claude
 * answers from its last sample during a rate-limit cooldown). Only the
 * providers the page reads are asked (`listUsagePageProviders`), so an agent
 * never causes a request the page would not make.
 *
 * Failures stay apart from usage: a provider that fails or does not answer in
 * time is its own failed entry, and a provider list that cannot be read falls
 * back to asking every provider, as the page does, never to "none configured".
 */

import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';

// The Usage page's own deadlines (packages/ui/src/lib/quota/fetchQuota.ts):
// the provider list, then each provider.
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

// A cancelled turn stops waiting; the shared provider reads go on for the
// other callers of `fetchQuotaForProvider`.
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

// The account a provider is signed in with (Codex gives an email) stays out:
// an agent needs the windows and resets, and the result goes to the session's
// model provider, which may be another company than the one the account is at.
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
  // Same shape as every provider's own result (`buildResult`), so the agent
  // reads one kind of entry.
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
