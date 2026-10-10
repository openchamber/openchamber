/**
 * Antigravity Provider - Transforms
 *
 * Data transformation functions for Antigravity quota responses.
 * @module quota/providers/antigravity/transforms
 */

import {
  asNonEmptyString,
  toNumber,
  toTimestamp,
  toUsageWindow
} from '../../utils/index.js';

export const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
export const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
export const DAILY_WINDOW_SECONDS = 24 * 60 * 60;

export const parseBucket = (bucket) => {
  const remainingFraction = toNumber(bucket?.remainingFraction);
  const remainingPercent = remainingFraction !== null
    ? Math.round(remainingFraction * 100)
    : null;
  const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
  const resetAt = toTimestamp(bucket?.resetTime);
  const windowStr = (bucket?.window || bucket?.bucketId || '').toLowerCase();

  let label = '5h';
  let seconds = FIVE_HOUR_WINDOW_SECONDS;

  if (windowStr.includes('week') || windowStr.includes('7d')) {
    label = 'weekly';
    seconds = WEEKLY_WINDOW_SECONDS;
  } else if (windowStr.includes('day') || windowStr.includes('daily')) {
    label = 'daily';
    seconds = DAILY_WINDOW_SECONDS;
  } else {
    label = '5h';
    seconds = FIVE_HOUR_WINDOW_SECONDS;
  }

  return {
    label,
    seconds,
    remainingFraction: remainingFraction ?? 1,
    window: toUsageWindow({
      usedPercent,
      windowSeconds: seconds,
      resetAt
    })
  };
};

export const transformSummary = (summaryPayload) => {
  const groups = Array.isArray(summaryPayload?.groups) ? summaryPayload.groups : [];
  const modelGroupWindows = [];

  for (const group of groups) {
    const groupName = (group?.displayName || '').toLowerCase();
    const is3p = groupName.includes('claude') || groupName.includes('gpt') || groupName.includes('3p');
    const groupType = is3p ? '3p' : 'gemini';

    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    const windows = {};
    let bucket5h = null;
    let bucketWeekly = null;

    for (const b of buckets) {
      const parsed = parseBucket(b);
      windows[parsed.label] = parsed.window;
      if (parsed.label === '5h') {
        bucket5h = parsed;
      } else if (parsed.label === 'weekly') {
        bucketWeekly = parsed;
      }
    }

    modelGroupWindows.push({
      groupType,
      displayName: group?.displayName,
      windows,
      bucket5h,
      bucketWeekly
    });
  }

  // The card carries no top-level windows: each model row shows its own
  // group's 5h/weekly, so a single overview row would only mislead (for
  // example a Gemini 5h window shown for someone whose Claude limit is spent).
  return { modelGroupWindows };
};

export const transformModels = (modelsPayload, modelGroupWindows = []) => {
  const rawModels = modelsPayload?.models ?? {};
  const transformed = {};

  for (const [modelName, modelData] of Object.entries(rawModels)) {
    const name = asNonEmptyString(modelName);
    if (!name) continue;

    const lowerName = name.toLowerCase();
    const is3p = lowerName.includes('claude') || lowerName.includes('gpt');
    const matchedGroup = modelGroupWindows.find((g) => is3p ? g.groupType === '3p' : g.groupType === 'gemini');

    if (matchedGroup && Object.keys(matchedGroup.windows).length > 0) {
      const isWeeklyConstrained = matchedGroup.bucketWeekly
        && (matchedGroup.bucketWeekly.remainingFraction <= 0.001
          || (matchedGroup.bucket5h && matchedGroup.bucketWeekly.remainingFraction < matchedGroup.bucket5h.remainingFraction));

      const reorderedWindows = {};
      if (isWeeklyConstrained && matchedGroup.windows.weekly) {
        reorderedWindows.weekly = matchedGroup.windows.weekly;
        if (matchedGroup.windows['5h']) {
          reorderedWindows['5h'] = matchedGroup.windows['5h'];
        }
      } else {
        if (matchedGroup.windows['5h']) {
          reorderedWindows['5h'] = matchedGroup.windows['5h'];
        }
        if (matchedGroup.windows.weekly) {
          reorderedWindows.weekly = matchedGroup.windows.weekly;
        }
      }

      for (const [wLabel, wData] of Object.entries(matchedGroup.windows)) {
        if (!reorderedWindows[wLabel]) {
          reorderedWindows[wLabel] = wData;
        }
      }

      transformed[name] = { windows: reorderedWindows };
    } else {
      // Fallback: if retrieveUserQuotaSummary did not return, fall back to the single-window quotaInfo from fetchAvailableModels
      const remainingFraction = toNumber(modelData?.quotaInfo?.remainingFraction);
      const remainingPercent = remainingFraction !== null
        ? Math.round(remainingFraction * 100)
        : null;
      const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
      const resetAt = toTimestamp(modelData?.quotaInfo?.resetTime);

      const remainingSeconds = resetAt !== null
        ? Math.max(0, Math.round((resetAt - Date.now()) / 1000))
        : null;

      let label = '5h';
      let seconds = FIVE_HOUR_WINDOW_SECONDS;
      if (remainingSeconds !== null && remainingSeconds > 36 * 60 * 60) {
        label = 'weekly';
        seconds = WEEKLY_WINDOW_SECONDS;
      } else if (remainingSeconds !== null && remainingSeconds > 10 * 60 * 60) {
        label = 'daily';
        seconds = DAILY_WINDOW_SECONDS;
      }

      transformed[name] = {
        windows: {
          [label]: toUsageWindow({
            usedPercent,
            windowSeconds: seconds,
            resetAt
          })
        }
      };
    }
  }

  return transformed;
};
