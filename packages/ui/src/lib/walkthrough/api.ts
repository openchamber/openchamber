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

const isJsonResponse = (response: Response): boolean =>
  /^application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get('content-type') ?? '');

/**
 * A server without these routes does not answer 404 with JSON. Unmatched
 * `/api/*` falls through to the OpenCode proxy, and OpenCode serves its embedded
 * web UI for any path it does not know — HTML, status 200. Parsing that as JSON
 * surfaced `Unexpected token '<', "<!doctype "...` in the panel, which names
 * neither the cause nor the remedy.
 *
 * Only a missing route is reported this way: 2xx and 404 are the shapes it
 * produces. A 5xx that is not JSON came from a server that did answer, so it
 * keeps its own failure rather than becoming advice to upgrade.
 */
const serverUnsupported = () =>
  new WalkthroughError('This OpenChamber server has no walkthrough API', { code: 'server-unsupported' });

const looksUnsupported = (response: Response): boolean =>
  !isJsonResponse(response) && (response.ok || response.status === 404);

// An authoritative read that fails must never look like "there is nothing
// here" — the caller would clear a perfectly good walkthrough off the screen.
const throwFromResponse = async (response: Response, fallback: string): Promise<never> => {
  if (looksUnsupported(response)) throw serverUnsupported();
  const payload = (await response.json().catch(() => null)) as ErrorPayload | null;
  throw new WalkthroughError(typeof payload?.error === 'string' ? payload.error : fallback, {
    code: typeof payload?.code === 'string' ? (payload.code as WalkthroughError['code']) : undefined,
    model: (payload?.model as WalkthroughResult['model']) ?? undefined,
    requiredChars: typeof payload?.requiredChars === 'number' ? payload.requiredChars : undefined,
    availableChars: typeof payload?.availableChars === 'number' ? payload.availableChars : undefined,
  });
};

const readJson = async <T>(response: Response): Promise<T> => {
  if (!isJsonResponse(response)) throw serverUnsupported();
  try {
    return (await response.json()) as T;
  } catch {
    // Declared JSON, arrived truncated or empty: still not an answer, and the
    // parser's own message says nothing a reader can act on.
    throw new WalkthroughError('The server returned a malformed walkthrough response');
  }
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
  return readJson<WalkthroughResult>(response);
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
  return readJson<WalkthroughResult>(response);
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
