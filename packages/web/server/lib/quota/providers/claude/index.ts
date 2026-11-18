
import { createHash } from 'crypto';

import { buildResult } from '../../utils/index.js';
import type { ProviderUsage, QuotaResult } from '../../utils/contracts.js';
import type { LegacyAuthFile } from '../../../opencode/auth.js';
import { findClaudeCredential, loadClaudeCredential } from './auth.js';
import type { ClaudeCredential } from './auth.js';
import { toClaudeUsage } from './transforms.js';

export const providerId = 'claude';
export const providerName = 'Claude';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;
const SESSION_EXPIRED_ERROR = 'Claude session expired. Open Claude Code to sign in again.';
const USAGE_DENIED_ERROR = 'Anthropic does not let this Claude token read usage. A token from `claude setup-token` cannot; a Claude Code sign-in (`/login`) can.';

let cachedUsage: { fingerprint: string; usage: ProviderUsage; planLabel: string | null } | null = null;
let cooldownUntil = 0;
let pendingFetch: Promise<QuotaResult> | null = null;
let lastFingerprint: string | null = null;

const fingerprintOf = (credential: ClaudeCredential) =>
  createHash('sha256').update(`${credential.accessToken}\0${credential.refreshToken ?? ''}`).digest('hex');

const cooldownFromHeader = (response: Response) => {
  const raw = response.headers.get('retry-after');
  const retryAfter = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, MAX_COOLDOWN_MS);
  }
  const retryAt = raw ? Date.parse(raw) : Number.NaN;
  if (Number.isFinite(retryAt) && retryAt > Date.now()) {
    return Math.min(retryAt - Date.now(), MAX_COOLDOWN_MS);
  }
  return DEFAULT_COOLDOWN_MS;
};

const cachedResultFor = (fingerprint: string, planLabel: string | null) => {
  if (!cachedUsage || cachedUsage.fingerprint !== fingerprint) return null;
  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage: cachedUsage.usage,
    planLabel: planLabel ?? cachedUsage.planLabel
  });
};

const failure = (error: string, { configured = true } = {}) =>
  buildResult({ providerId, providerName, ok: false, configured, error });

export const isConfigured = (auth: LegacyAuthFile) => Boolean(findClaudeCredential(auth));

const fetchQuotaUncoalesced = async () => {
  const credential = await loadClaudeCredential();
  if (!credential) {
    return failure('Not configured', { configured: false });
  }

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
    return cachedResultFor(fingerprint, credential.planLabel)
      ?? failure('Rate limited. Retrying soon.');
  }

  let response;
  try {
    response = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER
      }
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'Request failed');
  }

  if (response.status === 429) {
    cooldownUntil = Date.now() + cooldownFromHeader(response);
    return cachedResultFor(fingerprint, credential.planLabel)
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
  } catch {
    return failure('Unexpected response from Anthropic');
  }

  const { windows, models } = toClaudeUsage(payload);
  const usage = Object.keys(models).length > 0 ? { windows, models } : { windows };
  cachedUsage = { fingerprint, usage, planLabel: credential.planLabel };

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage,
    planLabel: credential.planLabel
  });
};

export const fetchQuota = () => {
  if (pendingFetch) return pendingFetch;

  const request = fetchQuotaUncoalesced();
  const pending = request.finally(() => {
    if (pendingFetch === pending) pendingFetch = null;
  });
  pendingFetch = pending;
  return pendingFetch;
};

export const resetClaudeQuotaCache = () => {
  cachedUsage = null;
  cooldownUntil = 0;
  pendingFetch = null;
  lastFingerprint = null;
};
