const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const USAGE_REQUEST_TIMEOUT_MS = 15_000;

export type UsageResponse = Pick<Response, 'ok' | 'status' | 'headers' | 'json'>;

export const isUsageTimeout = (error: unknown): error is DOMException => error instanceof DOMException && error.name === 'TimeoutError';

const rethrowWithDeadline = (signal: AbortSignal) => (error: Error): never => {
  throw signal.aborted ? signal.reason : error;
};

export const requestUsageWithDeadline = async (url: string, init: RequestInit): Promise<UsageResponse> => {
  const signal = AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS);
  const rethrow = rethrowWithDeadline(signal);
  const response = await fetch(url, { ...init, signal }).catch(rethrow);
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    json: () => response.json().catch(rethrow),
  };
};

export const requestCodexUsage = (accessToken: string, accountId: string | null | undefined): Promise<UsageResponse> => requestUsageWithDeadline(CODEX_USAGE_URL, {
  method: 'GET',
  redirect: 'error',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
  },
});
