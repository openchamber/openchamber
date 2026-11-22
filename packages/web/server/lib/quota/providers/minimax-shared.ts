import { readQuotaJson } from '../utils/response-body.js';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  asNonEmptyString,
} from '../utils/index.js';
import { miniMaxStatusError } from './minimax-status.js';
import { lowerCaseLabel } from '../utils/labels.js';
import type { LegacyAuthFile } from '../../opencode/auth.js';
import type { MiniMaxBaseResp } from './minimax-status.js';
import type { ProviderUsage } from '../utils/contracts.js';

type MiniMaxFields = {
  readonly key?: unknown; readonly token?: unknown; readonly model_remains?: unknown; readonly base_resp?: unknown;
  readonly model_name?: unknown; readonly current_interval_total_count?: unknown;
  readonly current_interval_usage_count?: unknown; readonly current_interval_remaining_percent?: unknown;
  readonly start_time?: unknown; readonly end_time?: unknown; readonly remains_time?: unknown;
  readonly current_weekly_total_count?: unknown; readonly current_weekly_usage_count?: unknown;
  readonly current_weekly_remaining_percent?: unknown; readonly weekly_start_time?: unknown;
  readonly weekly_end_time?: unknown; readonly weekly_remains_time?: unknown; readonly current_weekly_status?: unknown;
};
type EndpointRead = { payload?: MiniMaxFields; statusError?: string };
export type MiniMaxProviderOptions = {
  providerId: string;
  providerName: string;
  aliases: string[];
  tokenPlanUrl: string;
  codingPlanUrl: string;
};
export type MiniMaxQuotaOptions = {
  readAuth?: () => Promise<LegacyAuthFile>;
  fetchImpl?: typeof fetch;
};

const hasFields = (value: unknown): value is MiniMaxFields => value !== null && value !== undefined;
const fieldsOf = <Value>(value: Value) => (hasFields(value) ? value : undefined);
const isNumberValue = (value: unknown): value is number => typeof value === 'number';
const isBaseResp = (value: unknown): value is MiniMaxBaseResp => value !== null && value !== undefined;
const positive = (value: number | null) => value !== null && value > 0;

const WINDOW_STATUS_INACTIVE = 3;

const TEXT_MODELS = ['general', 'chat', 'text'];

const pickChatModel = <Remains>(modelRemains: Remains) => {
  if (!Array.isArray(modelRemains) || modelRemains.length === 0) return null;
  const models: unknown[] = modelRemains;

  const m3Candidate = models.find((m) => {
    const name = fieldsOf(m)?.model_name;
    return name && /^minimax-m/i.test(String(name)) && positive(toNumber(fieldsOf(m)?.current_interval_total_count));
  });
  if (m3Candidate) return m3Candidate;

  const textCandidate = models.find((m) => {
    const name = fieldsOf(m)?.model_name;
    return name && TEXT_MODELS.includes(lowerCaseLabel(name, 'm.model_name'));
  });
  if (textCandidate) return textCandidate;

  const percentCandidate = models.find((m) => isNumberValue(fieldsOf(m)?.current_interval_remaining_percent));
  if (percentCandidate) return percentCandidate;

  return models[0];
};

const hasModelRemains = <Payload>(payload: Payload) => {
  const rems = fieldsOf(payload)?.model_remains;
  return Array.isArray(rems) && rems.length > 0;
};

const fetchEndpoint = async <Key>(url: string, apiKey: Key, fetchImpl: typeof fetch): Promise<EndpointRead> => {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return {};
    const payload: unknown = await readQuotaJson(response);
    const baseResp = fieldsOf(payload)?.base_resp;
    const statusError = miniMaxStatusError(isBaseResp(baseResp) ? baseResp : undefined);
    if (statusError) return { statusError };
    if (!hasModelRemains(payload) || !hasFields(payload)) return {};
    return { payload };
  } catch {
    return {};
  }
};

const coercePercent = <Value>(value: Value) => {
  const n = toNumber(value);
  return n !== null ? Math.max(0, Math.min(100, n)) : null;
};

const isWindowActive = <Value>(status: Value) => {
  const n = toNumber(status);
  return n === null || n !== WINDOW_STATUS_INACTIVE;
};

/**
 * Calculate window duration in seconds from the API start/end timestamps.
 * remains_time is deliberately not a fallback: it is the time until the
 * window resets (confirmed via live API testing: 9664502 ms = 2.68h remaining
 * in a 5h window, consistent with remaining_percent), not the window's
 * duration, so reporting it as windowSeconds fabricates the duration. With
 * no usable start/end pair the duration is unknown and stays null.
 */
const calculateWindowSeconds = (startAt: number | null, resetAt: number | null) => {
  if (startAt && resetAt && resetAt > startAt) {
    return Math.floor((resetAt - startAt) / 1000);
  }
  return null;
};

const calculateUsage = (model: MiniMaxFields, isTokenPlan: boolean) => {
  const intervalTotal = toNumber(model.current_interval_total_count);
  const intervalUsageRaw = toNumber(model.current_interval_usage_count);
  const intervalStartAt = toTimestamp(model.start_time);
  const intervalResetAt = toTimestamp(model.end_time);
  const intervalRemainingPercent = coercePercent(model.current_interval_remaining_percent);

  const weeklyTotal = toNumber(model.current_weekly_total_count);
  const weeklyUsageRaw = toNumber(model.current_weekly_usage_count);
  const weeklyStartAt = toTimestamp(model.weekly_start_time);
  const weeklyResetAt = toTimestamp(model.weekly_end_time);
  const weeklyRemainingPercent = coercePercent(model.current_weekly_remaining_percent);

  let intervalUsedPercent = null;
  if (intervalRemainingPercent !== null) {
    intervalUsedPercent = 100 - intervalRemainingPercent;
  } else if (intervalTotal !== null && intervalTotal > 0 && intervalUsageRaw !== null) {
    const intervalUsed = isTokenPlan
      ? Math.max(0, intervalTotal - intervalUsageRaw)
      : intervalUsageRaw;
    intervalUsedPercent = Math.max(0, Math.min(100, (intervalUsed / intervalTotal) * 100));
  }

  let weeklyUsedPercent = null;
  if (weeklyRemainingPercent !== null) {
    weeklyUsedPercent = 100 - weeklyRemainingPercent;
  } else if (weeklyTotal !== null && weeklyTotal > 0 && weeklyUsageRaw !== null) {
    const weeklyUsed = isTokenPlan
      ? Math.max(0, weeklyTotal - weeklyUsageRaw)
      : weeklyUsageRaw;
    weeklyUsedPercent = Math.max(0, Math.min(100, (weeklyUsed / weeklyTotal) * 100));
  }

  const intervalWindowSeconds = calculateWindowSeconds(intervalStartAt, intervalResetAt);
  const weeklyWindowSeconds = calculateWindowSeconds(weeklyStartAt, weeklyResetAt);

  return {
    intervalUsedPercent,
    intervalWindowSeconds,
    intervalResetAt,
    weeklyUsedPercent,
    weeklyWindowSeconds,
    weeklyResetAt,
  };
};

export const createMiniMaxCodingPlanProvider = ({ providerId, providerName, aliases, tokenPlanUrl, codingPlanUrl }: MiniMaxProviderOptions) => {
  const getApiKey = (auth: LegacyAuthFile) => {
    const entry = fieldsOf(normalizeAuthEntry(getAuthEntry(auth, aliases)));
    return asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);
  };

  const isConfigured = (auth: LegacyAuthFile) => Boolean(getApiKey(auth));

  const fetchQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch }: MiniMaxQuotaOptions = {}) => {
    const auth = await readAuth();
    const apiKey = getApiKey(auth);

    if (!apiKey) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: false,
        error: 'Not configured',
      });
    }

    try {
      let { payload, statusError } = await fetchEndpoint(tokenPlanUrl, apiKey, fetchImpl);
      let isTokenPlan = true;

      if (!payload) {
        const fallback = await fetchEndpoint(codingPlanUrl, apiKey, fetchImpl);
        payload = fallback.payload;
        statusError ??= fallback.statusError;
        isTokenPlan = false;
      }

      if (!payload) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: statusError ?? 'API returned no usable quota data',
        });
      }

      const model = fieldsOf(pickChatModel(payload.model_remains));
      if (!model) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: 'No model quota data available',
        });
      }

      const {
        intervalUsedPercent,
        intervalWindowSeconds,
        intervalResetAt,
        weeklyUsedPercent,
        weeklyWindowSeconds,
        weeklyResetAt,
      } = calculateUsage(model, isTokenPlan);

      const windows: ProviderUsage['windows'] = {
        '5h': toUsageWindow({
          usedPercent: intervalUsedPercent,
          windowSeconds: intervalWindowSeconds,
          resetAt: intervalResetAt,
        }),
      };

      const weeklyActive = isWindowActive(model.current_weekly_status);
      const hasWeeklyData =
        weeklyActive &&
        (coercePercent(model.current_weekly_remaining_percent) !== null ||
          positive(toNumber(model.current_weekly_total_count)));

      if (hasWeeklyData) {
        windows.weekly = toUsageWindow({
          usedPercent: weeklyUsedPercent,
          windowSeconds: weeklyWindowSeconds,
          resetAt: weeklyResetAt,
        });
      }

      return buildResult({
        providerId,
        providerName,
        ok: true,
        configured: true,
        usage: { windows },
      });
    } catch (error) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: error instanceof Error ? error.message : 'Request failed',
      });
    }
  };

  return {
    providerId,
    providerName,
    aliases,
    isConfigured,
    fetchQuota,
  };
};
