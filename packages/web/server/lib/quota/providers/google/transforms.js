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

// This endpoint is the per-model projection of the Code Assist
// subscription the Antigravity provider reads (same cloudcode-pa
// backend, #1042): its buckets are not a separate daily pool, and the
// payload carries no window duration - only each bucket's real
// resetTime. The window therefore claims no duration; presenting a
// fabricated 'daily'/86400 window here double-counted the one
// subscription as independent headroom.
const resolveGoogleWindow = () => ({ label: 'per-model', seconds: null });

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
  const usedPercent = remainingPercent !== null ? Math.min(100, Math.max(0, 100 - remainingPercent)) : null;
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
  const usedPercent = remainingPercent !== null ? Math.min(100, Math.max(0, 100 - remainingPercent)) : null;
  const resetAt = toTimestamp(modelData?.quotaInfo?.resetTime);
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
