import { z } from 'zod';
import { sanitizeRuntimeRequestHeaders } from './runtime-request-headers.mjs';

const REQUEST_TIMEOUT_MS = 30_000;

// Every OpenChamber server since 1.9 answers its update route this way.
const startedResponse = z.object({ success: z.literal(true) });
const refusedResponse = z.object({ error: z.string().trim().min(1) });

const buildUpdateUrl = (url) => {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/api/openchamber/update-install`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

/**
 * Asks a saved remote host to update its own OpenChamber, through the same
 * route its web UI uses. The host installs the update and restarts itself;
 * the caller probes it afterwards to learn when the new version answers.
 *
 * Resolves `{ status: 'started' }`, `{ status: 'auth' }` when the saved token
 * is refused, or `{ status: 'failed', error }` with the host's own reason
 * (for example a server under a service manager it cannot restart) or `null`.
 */
export const requestRemoteHostUpdate = async ({
  url,
  clientToken = '',
  requestHeaders = {},
  chromiumFetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) => {
  const updateUrl = buildUpdateUrl(url);
  if (!updateUrl) return { status: 'failed', error: null };

  const headers = {
    ...sanitizeRuntimeRequestHeaders(requestHeaders),
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const token = String(clientToken || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await chromiumFetch(updateUrl, {
      method: 'POST',
      headers,
      body: '{}',
      signal: controller.signal,
      redirect: 'manual',
    });
    if (response.status === 401 || response.status === 403) return { status: 'auth' };
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      return startedResponse.safeParse(payload).success
        ? { status: 'started' }
        : { status: 'failed', error: null };
    }
    const refused = refusedResponse.safeParse(payload);
    return { status: 'failed', error: refused.success ? refused.data.error : null };
  } catch {
    return { status: 'failed', error: null };
  } finally {
    clearTimeout(timer);
  }
};
