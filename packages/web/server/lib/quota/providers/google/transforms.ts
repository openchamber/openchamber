import { z } from 'zod';
import {
  asNonEmptyString,
  toNumber,
  toTimestamp,
  toUsageWindow
} from '../../utils/index.js';
import type { JsonObject, JsonValue, ProviderUsage } from '../../utils/contracts.js';

const isJsonContainer = (value: JsonValue | undefined): value is JsonObject | JsonValue[] =>
  value !== null && typeof value === 'object';

const isNumber = (value: JsonValue | undefined): value is number => typeof value === 'number';

const GOOGLE_DAILY_WINDOW_SECONDS = 24 * 60 * 60;

export interface GoogleRefreshTokenParts {
  refreshToken: string | null;
  projectId: string | null;
  managedProjectId: string | null;
}

export const parseGoogleRefreshToken = z.unknown().transform((rawRefreshToken): GoogleRefreshTokenParts => {
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
}).parse;

const resolveGoogleWindow = () => ({ label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS });

export const transformQuotaBucket = (bucket: JsonValue | undefined, sourceId: string) => {
  const modelId = asNonEmptyString(isJsonContainer(bucket) && 'modelId' in bucket ? bucket.modelId : undefined);
  if (!modelId) {
    return null;
  }

  const scopedName = modelId.startsWith(`${sourceId}/`)
    ? modelId
    : `${sourceId}/${modelId}`;

  const remainingFraction = toNumber(isJsonContainer(bucket) && 'remainingFraction' in bucket ? bucket.remainingFraction : undefined);
  const remainingPercent = remainingFraction !== null
    ? Math.round(remainingFraction * 100)
    : null;
  const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
  const resetAt = toTimestamp(isJsonContainer(bucket) && 'resetTime' in bucket ? bucket.resetTime : undefined);
  const window = resolveGoogleWindow();

  return {
    [scopedName]: {
      windows: {
        [window.label]: toUsageWindow({
          usedPercent,
          windowSeconds: window.seconds,
          resetAt
        })
      }
    }
  } satisfies Record<string, ProviderUsage>;
};

export const transformModelData = (modelName: string, modelData: JsonValue | undefined, sourceId: string) => {
  const scopedName = modelName.startsWith(`${sourceId}/`)
    ? modelName
    : `${sourceId}/${modelName}`;

  const quotaInfo = isJsonContainer(modelData) && 'quotaInfo' in modelData ? modelData.quotaInfo : undefined;
  const remainingFraction = isJsonContainer(quotaInfo) && 'remainingFraction' in quotaInfo ? quotaInfo.remainingFraction : undefined;
  const remainingPercent = isNumber(remainingFraction)
    ? Math.round(remainingFraction * 100)
    : null;
  const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
  const resetTime = isJsonContainer(quotaInfo) && 'resetTime' in quotaInfo ? quotaInfo.resetTime : undefined;
  const resetAt = resetTime
    ? new Date(resetTime).getTime()
    : null;
  const window = resolveGoogleWindow();

  return {
    [scopedName]: {
      windows: {
        [window.label]: toUsageWindow({
          usedPercent,
          windowSeconds: window.seconds,
          resetAt
        })
      }
    }
  } satisfies Record<string, ProviderUsage>;
};
