import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  WalkthroughError,
  type WalkthroughResult,
  type WalkthroughSource,
  type WalkthroughStage,
} from './types';

const BASE = '/api/walkthrough';

interface ErrorPayload {
  error?: unknown;
  code?: unknown;
  model?: unknown;
  requiredChars?: unknown;
  availableChars?: unknown;
}

// An authoritative read that fails must never look like "there is nothing
// here" — the caller would clear a perfectly good walkthrough off the screen.
const throwFromResponse = async (response: Response, fallback: string): Promise<never> => {
  const payload = (await response.json().catch(() => null)) as ErrorPayload | null;
  throw new WalkthroughError(typeof payload?.error === 'string' ? payload.error : fallback, {
    code: typeof payload?.code === 'string' ? (payload.code as WalkthroughError['code']) : undefined,
    model: (payload?.model as WalkthroughResult['model']) ?? undefined,
    requiredChars: typeof payload?.requiredChars === 'number' ? payload.requiredChars : undefined,
    availableChars: typeof payload?.availableChars === 'number' ? payload.availableChars : undefined,
  });
};

export async function fetchWalkthrough(
  directory: string,
  source: WalkthroughSource,
  options: { model?: string; language?: string; signal?: AbortSignal } = {}
): Promise<WalkthroughResult> {
  const response = await runtimeFetch(BASE, {
    query: {
      directory,
      source: JSON.stringify(source),
      ...(options.model ? { model: options.model } : {}),
      ...(options.language ? { language: options.language } : {}),
    },
    signal: options.signal,
  });
  if (!response.ok) {
    return throwFromResponse(response, 'Failed to load walkthrough');
  }
  return response.json();
}

export async function generateWalkthrough(
  directory: string,
  source: WalkthroughSource,
  options: { force?: boolean; model?: string; language?: string; signal?: AbortSignal } = {}
): Promise<WalkthroughResult> {
  const response = await runtimeFetch(`${BASE}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      directory,
      source,
      force: options.force === true,
      ...(options.model ? { model: options.model } : {}),
      ...(options.language ? { language: options.language } : {}),
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    return throwFromResponse(response, 'Failed to generate walkthrough');
  }
  return response.json();
}

/**
 * Stop a running generation. Explicit, because merely leaving the page must not
 * throw away work the user is paying for.
 */
export async function cancelWalkthroughGeneration(
  directory: string,
  source: WalkthroughSource
): Promise<void> {
  const response = await runtimeFetch(`${BASE}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory, source }),
  });
  if (!response.ok) {
    await throwFromResponse(response, 'Failed to cancel walkthrough generation');
  }
}

/**
 * Current stage of a running generation. Reads server memory only, so this is
 * safe to poll — unlike the full read, which re-runs the whole git pipeline.
 */
export async function fetchWalkthroughStage(
  directory: string,
  source: WalkthroughSource,
  signal?: AbortSignal
): Promise<WalkthroughStage | null> {
  const response = await runtimeFetch(`${BASE}/progress`, {
    query: { directory, source: JSON.stringify(source) },
    signal,
  });
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as { stage?: unknown } | null;
  return typeof payload?.stage === 'string' ? (payload.stage as WalkthroughStage) : null;
}
