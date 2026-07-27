import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp
} from '../utils/index.js';
import {
  CLAUDE_SESSION_EXPIRED_ERROR,
  ensureClaudeUsageAccessToken,
  fetchClaudeUsagePayload,
} from './claude-oauth.js';
import { readClaudeCliOAuthAccessToken } from './claude-cli-auth.js';

export const providerId = 'claude';
export const providerName = 'Claude subscription';
const aliases = ['anthropic', 'claude'];

/**
 * Resolve whether Claude subscription usage can be probed.
 * Prefers Claude Code CLI OAuth (engine-aligned), then OpenCode auth.json.
 *
 * @returns {boolean}
 */
export const isConfigured = () => {
  if (readClaudeCliOAuthAccessToken()) return true;
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const openCodeToken = entry?.access ?? entry?.token;
  return typeof openCodeToken === 'string' && Boolean(openCodeToken.trim());
};

/**
 * @param {unknown} payload
 * @returns {Record<string, ReturnType<typeof toUsageWindow>>}
 */
export function mapClaudeUsageWindows(payload) {
  const windows = {};
  const fiveHour = payload?.five_hour ?? null;
  const sevenDay = payload?.seven_day ?? null;
  const sevenDaySonnet = payload?.seven_day_sonnet ?? null;
  const sevenDayOpus = payload?.seven_day_opus ?? null;

  if (fiveHour) {
    windows['5h'] = toUsageWindow({
      usedPercent: toNumber(fiveHour.utilization),
      windowSeconds: null,
      resetAt: toTimestamp(fiveHour.resets_at)
    });
  }
  if (sevenDay) {
    windows['7d'] = toUsageWindow({
      usedPercent: toNumber(sevenDay.utilization),
      windowSeconds: null,
      resetAt: toTimestamp(sevenDay.resets_at)
    });
  }
  if (sevenDaySonnet) {
    windows['7d-sonnet'] = toUsageWindow({
      usedPercent: toNumber(sevenDaySonnet.utilization),
      windowSeconds: null,
      resetAt: toTimestamp(sevenDaySonnet.resets_at)
    });
  }
  if (sevenDayOpus) {
    windows['7d-opus'] = toUsageWindow({
      usedPercent: toNumber(sevenDayOpus.utilization),
      windowSeconds: null,
      resetAt: toTimestamp(sevenDayOpus.resets_at)
    });
  }

  return windows;
}

/**
 * @param {number} status
 */
function usageAuthError(status) {
  if (status === 401) return CLAUDE_SESSION_EXPIRED_ERROR;
  return `API error: ${status}`;
}

export const fetchQuota = async () => {
  let access;
  try {
    access = await ensureClaudeUsageAccessToken();
  } catch {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: CLAUDE_SESSION_EXPIRED_ERROR,
    });
  }

  if (!access?.accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    let response = await fetchClaudeUsagePayload(access.accessToken);

    if (response.status === 401 && access.canRefresh) {
      try {
        access = await ensureClaudeUsageAccessToken({ forceRefresh: true });
      } catch {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: CLAUDE_SESSION_EXPIRED_ERROR,
        });
      }

      if (!access?.accessToken) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: CLAUDE_SESSION_EXPIRED_ERROR,
        });
      }

      response = await fetchClaudeUsagePayload(access.accessToken);
    }

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: usageAuthError(response.status)
      });
    }

    const payload = await response.json();
    const windows = mapClaudeUsageWindows(payload);

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
