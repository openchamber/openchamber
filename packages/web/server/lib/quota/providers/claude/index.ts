
import { createHash } from 'crypto';
import { z } from 'zod';

import { buildResult, toNumber } from '../../utils/index.js';
import type { ProviderUsage, QuotaResult } from '../../utils/contracts.js';
import { retryAfterAt } from '../../utils/retry-after.js';
import type { LegacyAuthFile } from '../../../opencode/auth.js';
import { findClaudeCredential, loadClaudeCredential, readClaudeCredentialContext } from './auth.js';
import type { ClaudeCredential, ClaudeCredentialContext } from './auth.js';
import { toClaudeUsage } from './transforms.js';

export const providerId = 'claude';
export const providerName = 'Claude';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const SESSION_EXPIRED_ERROR = 'Claude session expired. Open Claude Code to sign in again.';
const USAGE_DENIED_ERROR = 'Anthropic does not let this Claude token read usage. A token from `claude setup-token` cannot; a Claude Code sign-in (`/login`) can.';
const ACCOUNT_CHANGED_ERROR = 'Claude usage account changed. Refresh usage again.';

let cachedUsage: { fingerprint: string; usage: ProviderUsage; planLabel: string | null } | null = null;
let cooldownUntil = 0;
type PendingFetch = { context: ClaudeCredentialContext; promise: Promise<QuotaResult> };
let pendingFetch: PendingFetch | null = null;
let lastFingerprint: string | null = null;

const fingerprintOf = (credential: ClaudeCredential) =>
  createHash('sha256').update(`${credential.accessToken}\0${credential.refreshToken ?? ''}`).digest('hex');

const accountOf = ({ accountLabel, source }: ClaudeCredential) => ({
  accountLabel: accountLabel ?? null,
  accountSource: source === 'keychain' || source === 'credentials-file' ? 'claude-code' as const
    : source === 'env' ? 'claude-env' as const : undefined,
});

const cachedResultFor = (fingerprint: string, credential: ClaudeCredential) => {
  if (!cachedUsage || cachedUsage.fingerprint !== fingerprint) return null;
  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage: cachedUsage.usage,
    planLabel: credential.planLabel ?? cachedUsage.planLabel,
    ...accountOf(credential),
  });
};

const failure = (error: string, { configured = true } = {}) =>
  buildResult({ providerId, providerName, ok: false, configured, error });

export const isConfigured = (auth: LegacyAuthFile) => {
  const context = readClaudeCredentialContext();
  return Boolean(context.configDir || context.error || findClaudeCredential(auth, context));
};

const requestClaudeUsage = (accessToken: string, redirect?: RequestRedirect, signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)) => {
  const options: RequestInit = {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
    },
    signal,
  };
  if (redirect) options.redirect = redirect;
  return fetch(USAGE_URL, options);
};

const legacyAccountWindow = z.looseObject({ utilization: z.unknown().refine((value) => toNumber(value) !== null) });
const accountQuotaPayload = z.looseObject({
  limits: z.array(z.looseObject({ kind: z.string() }).refine(({ kind, percent }) =>
    !['session', 'weekly_all', 'weekly_scoped'].includes(kind) || toNumber(percent) !== null)).nullish(),
  five_hour: legacyAccountWindow.nullish(),
  seven_day: legacyAccountWindow.nullish(),
  spend: z.looseObject({ enabled: z.boolean() }).nullish(),
}).refine((payload) => 'limits' in payload || 'five_hour' in payload || 'seven_day' in payload || 'spend' in payload);

export const readClaudeAccountUsage = async ({ accessToken }: { accessToken: string }, deadline: AbortSignal) => {
  const response = await requestClaudeUsage(accessToken, 'error', AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
  if (response.status === 401) return { status: 'expired' } as const;
  if (response.status === 403) return { status: 'unsupported' } as const;
  if (response.status === 429) return { status: 'cooldown', retryAt: retryAfterAt(response), fallbackMs: DEFAULT_COOLDOWN_MS } as const;
  if (!response.ok) return { status: 'transient' } as const;
  const payload = accountQuotaPayload.safeParse(await response.json());
  if (!payload.success) return { status: 'transient' } as const;
  const usage = toClaudeUsage(payload.data);
  if (payload.data.spend?.enabled && !usage.windows.extra_usage) return { status: 'transient' } as const;
  return { status: 'fresh', usage, planLabel: null } as const;
};

const fetchQuotaUncoalesced = async (context: ClaudeCredentialContext, isCurrent: () => boolean) => {
  if (context.error) return failure(context.error);
  let credential;
  try {
    credential = await loadClaudeCredential(context);
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'Request failed');
  }
  if (!credential) {
    if (context.configDir) return failure('Claude usage is unavailable for CLAUDE_CONFIG_DIR. Sign in to Claude Code using that directory.');
    return failure('Not configured', { configured: false });
  }
  if (!isCurrent()) return failure(ACCOUNT_CHANGED_ERROR);

  const fingerprint = fingerprintOf(credential);
  if (lastFingerprint !== null && lastFingerprint !== fingerprint) {
    cachedUsage = null;
    cooldownUntil = 0;
  }
  lastFingerprint = fingerprint;

  const expiresAt = credential.expiresAt;
  if (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) {
    return failure(SESSION_EXPIRED_ERROR);
  }

  if (Date.now() < cooldownUntil) {
    return cachedResultFor(fingerprint, credential)
      ?? failure('Rate limited. Retrying soon.');
  }

  let response;
  try {
    response = await requestClaudeUsage(credential.accessToken);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') return failure('Request timed out');
    return failure(error instanceof Error ? error.message : 'Request failed');
  }

  if (!isCurrent()) return failure(ACCOUNT_CHANGED_ERROR);

  if (response.status === 429) {
    const now = Date.now();
    cooldownUntil = Math.min(retryAfterAt(response, now) ?? now + DEFAULT_COOLDOWN_MS, now + MAX_COOLDOWN_MS);
    return cachedResultFor(fingerprint, credential)
      ?? failure('Rate limited. Retrying soon.');
  }

  if (response.status === 401) {
    return failure(SESSION_EXPIRED_ERROR);
  }

  if (response.status === 403) {
    return failure(USAGE_DENIED_ERROR);
  }

  if (!response.ok) {
    return failure(`API error: ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') return failure('Request timed out');
    return failure('Unexpected response from Anthropic');
  }
  if (!isCurrent()) return failure(ACCOUNT_CHANGED_ERROR);

  const { windows, models } = toClaudeUsage(payload);
  const usage = Object.keys(models).length > 0 ? { windows, models } : { windows };
  cachedUsage = { fingerprint, usage, planLabel: credential.planLabel };

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage,
    planLabel: credential.planLabel,
    ...accountOf(credential),
  });
};

const sameSelection = (a: ClaudeCredentialContext, b: ClaudeCredentialContext) =>
  a.configDir === b.configDir && a.error === b.error;

const selectionOf = (context: ClaudeCredentialContext) =>
  createHash('sha256').update(JSON.stringify([context.configDir, context.error])).digest('hex').slice(0, 16);

export const fetchQuota = () => {
  const context = readClaudeCredentialContext();
  if (pendingFetch && sameSelection(pendingFetch.context, context)) return pendingFetch.promise;

  const selection = selectionOf(context);
  const isCurrent = () => pendingFetch === pending && sameSelection(readClaudeCredentialContext(), context);
  const pending: PendingFetch = {
    context,
    promise: fetchQuotaUncoalesced(context, isCurrent)
      .then((result): QuotaResult => {
        const current = readClaudeCredentialContext();
        if (result.error === ACCOUNT_CHANGED_ERROR || !sameSelection(current, context)) {
          return { ...failure(ACCOUNT_CHANGED_ERROR), selection: selectionOf(current) };
        }
        return { ...result, selection };
      })
      .finally(() => {
        if (pendingFetch === pending) pendingFetch = null;
      }),
  };
  pendingFetch = pending;
  return pending.promise;
};

export const resetClaudeQuotaCache = () => {
  cachedUsage = null;
  cooldownUntil = 0;
  pendingFetch = null;
  lastFingerprint = null;
};
