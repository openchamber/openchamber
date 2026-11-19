import {
  asNonEmptyString,
  toNumber,
  toTimestamp,
  toUsageWindow
} from '../../utils/index.js';
import { lowerCaseLabel } from '../../utils/labels.js';

export const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
export const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const DAILY_WINDOW_SECONDS = 24 * 60 * 60;

type PayloadFields = {
  readonly remainingFraction?: unknown; readonly resetTime?: unknown; readonly window?: unknown;
  readonly bucketId?: unknown; readonly groups?: unknown; readonly displayName?: unknown;
  readonly buckets?: unknown; readonly models?: unknown; readonly quotaInfo?: unknown;
};
const hasPayloadFields = (value: unknown): value is PayloadFields => value !== null && value !== undefined;
const payloadFields = <Value>(value: Value) => (hasPayloadFields(value) ? value : undefined);
const listOf = <Value>(value: Value): unknown[] => (Array.isArray(value) ? value : []);

type ParsedBucket = ReturnType<typeof parseBucket>;
type BucketWindow = ParsedBucket['window'];
type ModelGroupWindow = {
  groupType: '3p' | 'gemini';
  displayName: unknown;
  windows: Record<string, BucketWindow>;
  bucket5h: ParsedBucket | null;
  bucketWeekly: ParsedBucket | null;
};

export const parseBucket = <Bucket>(bucket: Bucket) => {
  const fields = payloadFields(bucket);
  const remainingFraction = toNumber(fields?.remainingFraction);
  const remainingPercent = remainingFraction !== null
    ? Math.round(remainingFraction * 100)
    : null;
  const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
  const resetAt = toTimestamp(fields?.resetTime);
  const windowStr = lowerCaseLabel(
    fields?.window || fields?.bucketId || '',
    '((intermediate value) || (intermediate value) || "")',
  );

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

export const transformSummary = <Payload>(summaryPayload: Payload) => {
  const groups = listOf(payloadFields(summaryPayload)?.groups);
  const modelGroupWindows: ModelGroupWindow[] = [];

  for (const group of groups) {
    const fields = payloadFields(group);
    const groupName = lowerCaseLabel(fields?.displayName || '', '((intermediate value) || "")');
    const is3p = groupName.includes('claude') || groupName.includes('gpt') || groupName.includes('3p');
    const groupType = is3p ? '3p' : 'gemini';

    const buckets = listOf(fields?.buckets);
    const windows: Record<string, BucketWindow> = {};
    let bucket5h: ParsedBucket | null = null;
    let bucketWeekly: ParsedBucket | null = null;

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
      displayName: fields?.displayName,
      windows,
      bucket5h,
      bucketWeekly
    });
  }

  return { modelGroupWindows };
};

const isPresent = (value: unknown): value is object | string | number | boolean | bigint | symbol =>
  value !== null && value !== undefined;

export const transformModels = <Payload>(modelsPayload: Payload, modelGroupWindows: ModelGroupWindow[] = []) => {
  const rawModels = payloadFields(modelsPayload)?.models;
  const modelEntries: [string, unknown][] = isPresent(rawModels) ? Object.entries(rawModels) : [];
  const transformed: Record<string, { windows: Record<string, BucketWindow> }> = {};

  for (const [modelName, modelData] of modelEntries) {
    const name = asNonEmptyString(modelName);
    if (!name) continue;

    const lowerName = name.toLowerCase();
    const is3p = lowerName.includes('claude') || lowerName.includes('gpt');
    const matchedGroup = modelGroupWindows.find((g) => is3p ? g.groupType === '3p' : g.groupType === 'gemini');

    if (matchedGroup && Object.keys(matchedGroup.windows).length > 0) {
      const isWeeklyConstrained = matchedGroup.bucketWeekly
        && (matchedGroup.bucketWeekly.remainingFraction <= 0.001
          || (matchedGroup.bucket5h && matchedGroup.bucketWeekly.remainingFraction < matchedGroup.bucket5h.remainingFraction));

      const reorderedWindows: Record<string, BucketWindow> = {};
      const weekly = matchedGroup.windows.weekly;
      const fiveHour = matchedGroup.windows['5h'];
      if (isWeeklyConstrained && weekly) {
        reorderedWindows.weekly = weekly;
        if (fiveHour) {
          reorderedWindows['5h'] = fiveHour;
        }
      } else {
        if (fiveHour) {
          reorderedWindows['5h'] = fiveHour;
        }
        if (weekly) {
          reorderedWindows.weekly = weekly;
        }
      }

      for (const [wLabel, wData] of Object.entries(matchedGroup.windows)) {
        if (!reorderedWindows[wLabel]) {
          reorderedWindows[wLabel] = wData;
        }
      }

      transformed[name] = { windows: reorderedWindows };
    } else {
      const quotaInfo = payloadFields(payloadFields(modelData)?.quotaInfo);
      const remainingFraction = toNumber(quotaInfo?.remainingFraction);
      const remainingPercent = remainingFraction !== null
        ? Math.round(remainingFraction * 100)
        : null;
      const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
      const resetAt = toTimestamp(quotaInfo?.resetTime);

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
