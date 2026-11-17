import { readQuotaJson } from '../utils/response-body.js';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import { readConfigLayers } from '../../opencode/shared.js';
import { isRecord } from '../../opencode/config-v2.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  resolveWindowLabel,
  asNonEmptyString
} from '../utils/index.js';

export const providerId = 'codex';
export const providerName = 'Codex';
export const aliases = ['openai', 'codex', 'chatgpt'];

const clampPercent = (value) => value === null ? null : Math.min(100, Math.max(0, value));

const getAccessToken = (entry) => asNonEmptyString(entry?.access) ?? asNonEmptyString(entry?.token);

export const isConfigured = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(getAccessToken(entry));
};

const fetchQuotaForEntry = async (entry) => {
  const accessToken = getAccessToken(entry);
  const accountId = entry?.accountId;

  if (!accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {})
    };
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers,
      signal: timeoutSignal
    });

    if (!response.ok) {
      // A 401 is not always an expired token. OpenCode's `chatgpt-token-sharing`
      // sign-in ("Sign in with ChatGPT") holds a token that only reaches the
      // Responses route, and the usage endpoint refuses it with an
      // access-enforcement body (`rejected_by_access_enforcement`). OpenAI has no
      // usage endpoint for that sign-in and sends users to the ChatGPT usage page
      // instead, so the message does the same rather than asking to sign in again.
      if (response.status === 401) {
        const body = await readQuotaJson(response).catch(() => null);
        const errorType = asNonEmptyString(body?.error?.type);
        if (errorType === 'rejected_by_access_enforcement') {
          return buildResult({
            providerId,
            providerName,
            ok: false,
            configured: true,
            error: 'OpenAI shows usage for Sign in with ChatGPT only at chatgpt.com/settings/usage. The legacy Codex sign-ins show it here.'
          });
        }
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: 'Session expired \u2014 please re-authenticate with OpenAI'
        });
      }
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload = await readQuotaJson(response);
    const primary = payload?.rate_limit?.primary_window ?? null;
    const secondary = payload?.rate_limit?.secondary_window ?? null;
    const credits = payload?.credits ?? null;

    const windows = {};
    if (primary) {
      const windowSeconds = toNumber(primary.limit_window_seconds);
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: clampPercent(toNumber(primary.used_percent)),
        windowSeconds,
        resetAt: toTimestamp(primary.reset_at)
      });
    }
    if (secondary) {
      const windowSeconds = toNumber(secondary.limit_window_seconds);
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: clampPercent(toNumber(secondary.used_percent)),
        windowSeconds,
        resetAt: toTimestamp(secondary.reset_at)
      });
    }
    if (credits) {
      const balance = toNumber(credits.balance);
      const unlimited = Boolean(credits.unlimited);
      const label = unlimited
        ? 'Unlimited'
        : balance !== null
          ? String(balance)
          : null;
      windows.credits_balance = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: label
      });
    }

    // Business/enterprise accounts expose a dollar spend cap under
    // `spend_control.individual_limit`. Surface it as an additive `credits`
    // window so existing consumers keep working.
    if (payload?.spend_control?.individual_limit) {
      const spendLimit = payload.spend_control.individual_limit;
      const used = toNumber(spendLimit.used);
      const limit = toNumber(spendLimit.limit);
      const valueLabel = used !== null && limit !== null
        ? `${used.toFixed(0)} / ${limit.toFixed(0)} used`
        : null;
      windows.credits = toUsageWindow({
        usedPercent: clampPercent(toNumber(spendLimit.used_percent)),
        windowSeconds: null,
        resetAt: null,
        valueLabel
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows },
      // The usage payload names the account it metered. Surface it so a
      // per-credential result can be told apart from another account's.
      accountLabel: asNonEmptyString(payload?.email) ?? asNonEmptyString(payload?.account_id)
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : (error instanceof Error ? error.message : 'Request failed')
    });
  }
};

/**
 * The ids of configured provider instances of a Codex base (`openai`, ...),
 * in merged-config order. Since the provider re-seat the ChatGPT accounts
 * live under instance integrations (`openai.main`, `openai.alternate`), so
 * the bare integration read finds nothing; the instances are discovered
 * from the merged config, never hardcoded. A config that cannot be read
 * answers none, mirroring the registry's config-facts read.
 */
const readCodexInstanceIds = () => {
  try {
    const { mergedConfig } = readConfigLayers();
    const ids = [];
    for (const sectionKey of ['providers', 'provider']) {
      const section = mergedConfig?.[sectionKey];
      if (!isRecord(section)) continue;
      for (const [id, definition] of Object.entries(section)) {
        if (isRecord(definition) && aliases.includes(asNonEmptyString(definition.instanceOf))) ids.push(id);
      }
    }
    return ids;
  } catch (error) {
    console.warn('Quota: failed to read the OpenCode config; Codex instance credentials are not considered.', error);
    return [];
  }
};

const entryWithToken = (entry) => {
  const normalized = normalizeAuthEntry(entry);
  return normalized && getAccessToken(normalized) ? normalized : null;
};

/**
 * The credential the single Codex fetch uses: the bare integration's entry,
 * or — when the re-seat left the bare integration empty — the first usable
 * instance entry. The per-credential dispatch folds every instance into
 * the base row instead (see providers/index.js).
 */
const resolveCodexEntry = (auth) => {
  const direct = entryWithToken(getAuthEntry(auth, aliases));
  if (direct) return direct;
  for (const instanceId of readCodexInstanceIds()) {
    const entry = entryWithToken(getAuthEntry(auth, [instanceId]));
    if (entry) return entry;
  }
  return null;
};

export const fetchQuota = async ({ readAuth = readOpenCodeCredentials } = {}) => {
  const auth = await readAuth();
  return fetchQuotaForEntry(resolveCodexEntry(auth));
};

/** Quota for one stored credential row, fetched with that row's own token. */
export const fetchQuotaForCredential = async (credential) => (
  fetchQuotaForEntry(normalizeAuthEntry(credential?.value))
);
