/**
 * Claude subscription quota.
 *
 * Reports the plan limits Claude Code itself is bound by (rolling session
 * window, weekly windows, model-scoped weekly windows, and paid extra usage)
 * using the OAuth credential Claude Code already holds.
 *
 * @module quota/providers/claude
 */

import { createHash } from 'crypto';

import { buildResult } from '../../utils/index.js';
import { loadClaudeCredential } from './auth.js';
import { toClaudeUsage } from './transforms.js';

export const providerId = 'claude';
export const providerName = 'Claude';
export const aliases = ['anthropic', 'claude'];

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Last good payload, kept only to survive Anthropic's aggressive rate limiting.
 * Keyed by credential fingerprint so a second account never sees the first
 * account's numbers.
 *
 * @type {{ fingerprint: string, usage: object, planLabel: string|null }|null}
 */
let cachedUsage = null;
let cooldownUntil = 0;
let pendingFetch = null;

const fingerprintOf = (credential) =>
  createHash('sha256').update(`${credential.accessToken}\0${credential.refreshToken ?? ''}`).digest('hex');

const cooldownFromHeader = (response) => {
  const raw = response.headers.get('retry-after');
  const retryAfter = Number(raw);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_COOLDOWN_MS);
  }
  const retryAt = raw ? Date.parse(raw) : Number.NaN;
  if (Number.isFinite(retryAt) && retryAt > Date.now()) {
    return Math.min(retryAt - Date.now(), MAX_COOLDOWN_MS);
  }
  return DEFAULT_COOLDOWN_MS;
};

const cachedResultFor = (fingerprint, planLabel) => {
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

const failure = (error, { configured = true } = {}) =>
  buildResult({ providerId, providerName, ok: false, configured, error });

export const isConfigured = () => Boolean(loadClaudeCredential());

const fetchQuotaUncoalesced = async () => {
  const credential = loadClaudeCredential();
  if (!credential) {
    return failure('Not configured', { configured: false });
  }

  const fingerprint = fingerprintOf(credential);
  if (cachedUsage && cachedUsage.fingerprint !== fingerprint) {
    cachedUsage = null;
    cooldownUntil = 0;
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

  if (response.status === 401 || response.status === 403) {
    return failure('Claude session expired. Open Claude Code to sign in again.');
  }

  if (!response.ok) {
    return failure(`API error: ${response.status}`);
  }

  let payload;
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

/** Test seam: clears the rate-limit cache between cases. */
export const resetClaudeQuotaCache = () => {
  cachedUsage = null;
  cooldownUntil = 0;
  pendingFetch = null;
};
