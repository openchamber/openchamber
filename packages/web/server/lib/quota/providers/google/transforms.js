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

const GOOGLE_DAILY_WINDOW_SECONDS = 24 * 60 * 60;

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

const resolveGoogleWindow = () => ({ label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS });

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
  };
};
