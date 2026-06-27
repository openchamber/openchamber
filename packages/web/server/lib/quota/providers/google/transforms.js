/**
 * Google Provider - Transforms
 *
 * Data transformation functions for Google quota responses.
 * @module quota/providers/google/transforms
 */

import {
  asNonEmptyString,
  toNumber,
  toTimestamp,
  toUsageWindow
} from '../../utils/index.js';

const GOOGLE_FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const GOOGLE_DAILY_WINDOW_SECONDS = 24 * 60 * 60;

const ANTIGRAVITY_GROUPS = [
  { key: 'claude', display: 'Claude' },
  { key: 'gpt-oss', display: 'GPT-OSS' },
  { key: 'gemini-flash', display: 'Gemini Flash' },
  { key: 'gemini-pro', display: 'Gemini Pro' }
];

const classifyAntigravityGroup = (modelId) => {
  const m = String(modelId ?? '').toLowerCase();
  if (m.startsWith('chat_') || m.startsWith('tab_')) return null;
  if (m.includes('claude')) return 'claude';
  if (m.includes('gpt-oss') || m.includes('gpt')) return 'gpt-oss';
  if (!m.includes('gemini')) return null;
  return m.includes('flash') ? 'gemini-flash' : 'gemini-pro';
};

export const parseGoogleRefreshToken = (rawRefreshToken) => {
  const refreshToken = asNonEmptyString(rawRefreshToken);
  if (!refreshToken) {
    return { refreshToken: null, projectId: null, managedProjectId: null };
  }

  const [rawToken = '', rawProject = '', rawManagedProject = ''] = refreshToken.split('|');
  return {
    refreshToken: asNonEmptyString(rawToken),
    projectId: asNonEmptyString(rawProject),
    managedProjectId: asNonEmptyString(rawManagedProject)
  };
};

const resolveGoogleWindow = (sourceId, resetAt) => {
  if (sourceId === 'gemini') {
    return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS };
  }

  if (sourceId === 'antigravity') {
    const remainingSeconds = typeof resetAt === 'number'
      ? Math.max(0, Math.round((resetAt - Date.now()) / 1000))
      : null;

    if (remainingSeconds !== null && remainingSeconds > 10 * 60 * 60) {
      return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS };
    }

    return { label: '5h', seconds: GOOGLE_FIVE_HOUR_WINDOW_SECONDS };
  }

  return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS };
};

export const transformQuotaBucket = (bucket, sourceId) => {
  const modelId = asNonEmptyString(bucket?.modelId);
  if (!modelId) {
    return null;
  }

  const scopedName = modelId.startsWith(`${sourceId}/`)
    ? modelId
    : `${sourceId}/${modelId}`;

  const remainingFraction = toNumber(bucket?.remainingFraction);
  const remainingPercent = remainingFraction !== null
    ? Math.round(remainingFraction * 100)
    : null;
  const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
  const resetAt = toTimestamp(bucket?.resetTime);
  const window = resolveGoogleWindow(sourceId, resetAt);
  const suffix = sourceId === 'antigravity' ? 'Antigravity' : 'Gemini';

  return {
    [scopedName]: {
      windows: {
        [window.label]: toUsageWindow({
          usedPercent,
          windowSeconds: window.seconds,
          resetAt,
          suffix,
          trendKey: `google:${scopedName}:${window.label}`
        })
      }
    }
  };
};

export const transformModelData = (modelName, modelData, sourceId) => {
  const scopedName = modelName.startsWith(`${sourceId}/`)
    ? modelName
    : `${sourceId}/${modelName}`;

  const remainingFraction = modelData?.quotaInfo?.remainingFraction;
  const remainingPercent = typeof remainingFraction === 'number'
    ? Math.round(remainingFraction * 100)
    : null;
  const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
  const resetAt = modelData?.quotaInfo?.resetTime
    ? new Date(modelData.quotaInfo.resetTime).getTime()
    : null;
  const window = resolveGoogleWindow(sourceId, resetAt);
  const suffix = sourceId === 'antigravity' ? 'Antigravity' : 'Gemini';

  return {
    [scopedName]: {
      windows: {
        [window.label]: toUsageWindow({
          usedPercent,
          windowSeconds: window.seconds,
          resetAt,
          suffix,
          trendKey: `google:${scopedName}:${window.label}`
        })
      }
    }
  };
};

// Aggregate antigravity retrieveUserQuota buckets into family windows
// (gemini-pro, gemini-flash, claude, gpt-oss), matching canonical
// aggregateAntigravityQuota: minimum remainingFraction across the family,
// earliest resetTime. Drops chat_*/tab_* helper models. Returns a windows
// object keyed by family display label.
export const transformAntigravityBuckets = (buckets) => {
  const groups = {};
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    const modelId = asNonEmptyString(bucket?.modelId);
    if (!modelId) continue;
    const group = classifyAntigravityGroup(modelId);
    if (!group) continue;

    const rawFraction = toNumber(bucket?.remainingFraction);
    const fraction = rawFraction !== null
      ? Math.max(0, Math.min(1, rawFraction))
      : null;
    const resetAt = toTimestamp(bucket?.resetTime);
    const existing = groups[group];

    const nextRemaining = fraction === null
      ? existing?.remainingFraction
      : existing?.remainingFraction === undefined
        ? fraction
        : Math.min(existing.remainingFraction, fraction);

    let nextResetAt = existing?.resetAt;
    if (resetAt !== null) {
      if (existing?.resetAt === undefined || resetAt < existing.resetAt) {
        nextResetAt = resetAt;
      }
    }

    groups[group] = {
      remainingFraction: nextRemaining,
      resetAt: nextResetAt,
      modelCount: (existing?.modelCount ?? 0) + 1
    };
  }

  const windows = {};
  for (const { key, display } of ANTIGRAVITY_GROUPS) {
    const info = groups[key];
    if (!info || info.remainingFraction === undefined) continue;
    const remainingPercent = Math.round(info.remainingFraction * 100);
    const usedPercent = Math.max(0, 100 - remainingPercent);
    const window = resolveGoogleWindow('antigravity', info.resetAt);
    windows[display] = toUsageWindow({
      usedPercent,
      windowSeconds: window.seconds,
      resetAt: info.resetAt,
      suffix: 'Antigravity',
      trendKey: `google:antigravity:${display}`
    });
  }
  return windows;
};
