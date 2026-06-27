import { buildResult } from '../../utils/index.js';
import {
  resolveGoogleAuthSources,
  resolveGoogleOAuthClient,
  DEFAULT_PROJECT_ID
} from './auth.js';
import {
  transformQuotaBucket,
  transformModelData,
  transformAntigravityBuckets
} from './transforms.js';
import {
  refreshGoogleAccessToken,
  fetchGoogleQuotaBuckets,
  fetchGoogleModels
} from './api.js';

export { resolveGoogleAuthSources } from './auth.js';

export const providerId = 'google';
export const providerName = 'Google';
export const aliases = ['google', 'google.oauth'];

export const isConfigured = () => resolveGoogleAuthSources().length > 0;

export const fetchGoogleQuota = async () => {
  const authSources = resolveGoogleAuthSources();
  if (!authSources.length) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const models = {};
  const accounts = [];
  const sourceErrors = [];

  for (const source of authSources) {
    const now = Date.now();
    let accessToken = source.accessToken;

    if (!accessToken || (typeof source.expires === 'number' && source.expires <= now)) {
      if (!source.refreshToken) {
        sourceErrors.push(`${source.sourceLabel}: Missing refresh token`);
        continue;
      }
      const { clientId, clientSecret } = resolveGoogleOAuthClient(source.sourceId);
      accessToken = await refreshGoogleAccessToken(source.refreshToken, clientId, clientSecret);
    }

    if (!accessToken) {
      sourceErrors.push(`${source.sourceLabel}: Failed to refresh OAuth token`);
      continue;
    }

    const projectId = source.projectId ?? DEFAULT_PROJECT_ID;

    if (source.sourceId === 'gemini') {
      const quotaPayload = await fetchGoogleQuotaBuckets(accessToken, projectId);
      const buckets = Array.isArray(quotaPayload?.buckets) ? quotaPayload.buckets : [];

      for (const bucket of buckets) {
        const transformed = transformQuotaBucket(bucket, source.sourceId);
        if (transformed) {
          Object.assign(models, transformed);
        }
      }

      const payload = await fetchGoogleModels(accessToken, projectId);
      if (payload) {
        for (const [modelName, modelData] of Object.entries(payload.models ?? {})) {
          const transformed = transformModelData(modelName, modelData, source.sourceId);
          Object.assign(models, transformed);
        }
      }
      continue;
    }

    if (source.sourceId === 'antigravity') {
      const quotaPayload = await fetchGoogleQuotaBuckets(accessToken, projectId);
      const buckets = Array.isArray(quotaPayload?.buckets) ? quotaPayload.buckets : [];
      const windows = transformAntigravityBuckets(buckets);

      if (Object.keys(windows).length === 0) {
        sourceErrors.push(`${source.sourceLabel}: No quota buckets`);
        continue;
      }

      accounts.push({
        accountKey: source.email ?? source.sourceLabel,
        label: source.email ?? source.sourceLabel,
        subtitle: source.email ?? undefined,
        windows
      });
    }
  }

  if (!Object.keys(models).length && accounts.length === 0) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: sourceErrors[0] ?? 'Failed to fetch models'
    });
  }

  const sourceLabels = authSources.map((source) => source.sourceLabel);
  const subtitle = sourceLabels.length > 0
    ? sourceLabels.join(' + ')
    : 'Google Cloud Code';

  const usage = {
    windows: {},
    subtitle,
    models: Object.keys(models).length ? models : undefined
  };

  if (accounts.length > 0) {
    usage.accounts = accounts;
    usage.windows = accounts[0].windows;
  }

  if (sourceErrors.length > 0) {
    usage.note = `${sourceErrors.length} source(s) failed`;
  }

  const singleEmail = authSources.length === 1 ? authSources[0]?.email : null;

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage,
    accountKey: singleEmail ?? undefined
  });
};