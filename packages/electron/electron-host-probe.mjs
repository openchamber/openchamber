import { sanitizeRuntimeRequestHeaders } from './runtime-request-headers.mjs';
import { z } from 'zod';

const optionalIdentity = z.string().catch('').transform((value) => value.trim());
const versionEnvelope = z.object({
  status: z.literal('ok'),
  compatibility: z.union([z.looseObject({}), z.array(z.unknown())]),
  openchamberVersion: optionalIdentity,
});

const buildProbeUrl = (url, pathname) => {
  try {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '') || ''}${pathname}`;
    return parsed.toString();
  } catch {
    return null;
  }
};

const isServerBeforeOpenCode2 = (version) => {
  const major = /^(\d+)\./.exec(version)?.[1];
  return major !== undefined && Number(major) < 2;
};

const classifyVersionPayload = (payload) => {
  const parsed = versionEnvelope.safeParse(payload);
  if (!parsed.success) {
    return 'wrong-service';
  }
  const { compatibility, openchamberVersion } = parsed.data;
  if (!Array.isArray(compatibility.capabilities) || !compatibility.capabilities.includes('api.runtime-url.v1')) {
    return 'incompatible';
  }
  if (isServerBeforeOpenCode2(openchamberVersion)) {
    return 'incompatible';
  }
  if (compatibility.apiVersion !== 1 || compatibility.minClientApiVersion > 1) {
    return 'update-recommended';
  }
  return 'ok';
};

export const probeElectronHostWithDeadline = async ({
  url,
  timeoutMs,
  clientToken = '',
  requestHeaders = {},
  expectedServerId = '',
  chromiumFetch,
  isReady,
  now = Date.now,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
}) => {
  let requestStarted = now();
  const result = (status) => ({ status, latencyMs: now() - requestStarted });
  if (!isReady()) return result('unreachable');

  const versionUrl = buildProbeUrl(url, '/api/version');
  const sessionUrl = buildProbeUrl(url, '/auth/session');
  if (!versionUrl || !sessionUrl) throw new Error('Invalid URL');

  const controller = new AbortController();
  let rejectDeadline;
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = scheduleTimeout(() => {
    controller.abort();
    rejectDeadline(new Error('Host probe deadline exceeded'));
  }, timeoutMs);

  const responses = new Set();
  const discardBody = async (response) => {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
  };
  const fetchProbe = async (requestUrl, headers) => {
    controller.signal.throwIfAborted();
    requestStarted = now();
    const response = await chromiumFetch(requestUrl, {
      headers,
      signal: controller.signal,
      redirect: 'manual',
      cache: 'no-store',
    });
    if (controller.signal.aborted) {
      await discardBody(response);
      controller.signal.throwIfAborted();
    }
    responses.add(response);
    return response;
  };

  const run = async () => {
    const expectedIdentity = optionalIdentity.parse(expectedServerId);
    if (expectedIdentity) {
      const healthUrl = buildProbeUrl(url, '/health');
      if (healthUrl) {
        try {
          const response = await fetchProbe(healthUrl, { Accept: 'application/json' });
          if (response.status >= 300 && response.status < 400 || response.redirected) return result('wrong-service');
          if (response.ok) {
            const payload = await response.json().catch(() => null);
            const reported = optionalIdentity.parse(payload?.serverId);
            if (reported && reported !== expectedIdentity) return result('wrong-service');
          }
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // external: https://www.electronjs.org/docs/latest/api/net Electron 43 net.fetch rejects manual redirects instead of returning a 3xx response.
          if (error instanceof Error && error.message === 'Redirect was cancelled') return result('wrong-service');
        }
      }
    }

    if (controller.signal.aborted) throw new Error('Host probe deadline exceeded');
    const headers = { ...sanitizeRuntimeRequestHeaders(requestHeaders), Accept: 'application/json' };
    const token = optionalIdentity.parse(clientToken);
    if (token) headers.Authorization = `Bearer ${token}`;

    const versionResponse = await fetchProbe(versionUrl, headers);
    if (versionResponse.status === 401 || versionResponse.status === 403) return result('auth');
    if (!versionResponse.ok) return result('unreachable');
    const versionStatus = classifyVersionPayload(await versionResponse.json().catch(() => null));
    if (versionStatus !== 'ok') return result(versionStatus);

    const sessionResponse = await fetchProbe(sessionUrl, headers);
    if (sessionResponse.status === 401 || sessionResponse.status === 403) return result('auth');
    if (!sessionResponse.ok) return result('unreachable');
    return result('ok');
  };

  try {
    return await Promise.race([run(), deadline]);
  } catch {
    return result('unreachable');
  } finally {
    controller.abort();
    await Promise.allSettled([...responses].map(discardBody));
    cancelTimeout(timer);
  }
};
