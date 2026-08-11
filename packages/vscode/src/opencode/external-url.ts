import { resolvePortFromUrl, waitForReady } from './readiness';
import type { ReadyResult } from './types';

export type ExternalUrlConnectResult =
  | {
      ok: true;
      baseUrl: string;
      version: string | null;
      detectedPort: number | null;
      elapsedMs: number;
      attempts: number;
    }
  | {
      ok: false;
      error: string;
      elapsedMs: number;
      attempts: number;
    };

/**
 * Probe an externally configured OpenCode API URL before marking connected.
 * Extracted so connection policy is unit-testable without mocking the VS Code module.
 */
export async function connectExternalOpenCodeUrl(
  configuredApiUrl: string,
  authHeaders: Record<string, string>,
  timeoutMs: number,
  readyCheck: typeof waitForReady = waitForReady,
): Promise<ExternalUrlConnectResult> {
  const ready: ReadyResult = await readyCheck(configuredApiUrl, timeoutMs, authHeaders);
  if (ready.ok) {
    return {
      ok: true,
      baseUrl: ready.baseUrl,
      version: ready.version,
      detectedPort: resolvePortFromUrl(ready.baseUrl),
      elapsedMs: ready.elapsedMs,
      attempts: ready.attempts,
    };
  }

  return {
    ok: false,
    error: `External OpenCode API is not healthy at ${configuredApiUrl.replace(/\/+$/, '')}`,
    elapsedMs: ready.elapsedMs,
    attempts: ready.attempts,
  };
}
