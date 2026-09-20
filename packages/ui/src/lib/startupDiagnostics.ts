import { z } from 'zod';
import { runtimeFetch } from './runtime-fetch';

const ansiEscape = String.fromCharCode(27);
const ansiSequence = new RegExp(`${ansiEscape}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const diagnosticText = z.string().transform((value) => value.replace(ansiSequence, '').trim()).nullish();
const healthSchema = z.object({
  isOpenCodeReady: z.boolean().optional(),
  openCodeRunning: z.boolean().optional(),
  lastOpenCodeError: diagnosticText,
  opencodeBinaryResolved: diagnosticText,
  lastOpenCodeLaunchDiagnostics: z.object({
    sourceBinary: diagnosticText,
    binary: diagnosticText,
  }).nullish(),
});

export type StartupDiagnostics = {
  error: string | null;
  binary: string | null;
};

export const fetchStartupDiagnostics = async (
  signal: AbortSignal,
  request: typeof runtimeFetch = runtimeFetch,
): Promise<StartupDiagnostics | null> => {
  const response = await request('/health', {
    signal,
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Startup diagnostics request failed (${response.status})`);
  const health = healthSchema.parse(await response.json());

  // A historical process error is not a current failure after OpenCode recovers.
  if (health.isOpenCodeReady === true) return null;
  if (health.isOpenCodeReady !== false && health.openCodeRunning !== false) return null;

  return {
    error: health.lastOpenCodeError || null,
    binary: health.lastOpenCodeLaunchDiagnostics?.sourceBinary
      || health.opencodeBinaryResolved
      || health.lastOpenCodeLaunchDiagnostics?.binary
      || null,
  };
};
