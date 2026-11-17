import { runtimeFetch } from '@/lib/runtime-fetch';
import { hasSameSourceControlReadContext } from '@/lib/source-control/identity';
import type { SourceControlReadContext } from '@/lib/source-control/types';
import {
  WalkthroughError,
  type WalkthroughResult,
  type WalkthroughStage,
  type WalkthroughTarget,
} from './types';

const BASE = '/api/walkthrough';
const WALKTHROUGH_STAGES: readonly WalkthroughStage[] = ['collecting', 'asking', 'retrying', 'assembling'];

interface ErrorPayload {
  error?: unknown;
  code?: unknown;
  model?: unknown;
  requiredChars?: unknown;
  availableChars?: unknown;
}

const isJsonResponse = (response: Response): boolean =>
  /^application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get('content-type') ?? '');

const serverUnsupported = () =>
  new WalkthroughError('This OpenChamber server has no walkthrough API', { code: 'server-unsupported' });

const looksUnsupported = (response: Response): boolean =>
  !isJsonResponse(response) && (response.ok || response.status === 404);

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
    throw new WalkthroughError('The server returned a malformed walkthrough response');
  }
};

const isPullRequestTarget = (
  target: WalkthroughTarget,
): target is Extract<WalkthroughTarget, { source: { kind: 'pr' } }> => target.source.kind === 'pr';

const hasMatchingContext = (
  result: WalkthroughResult,
  target: Extract<WalkthroughTarget, { source: { kind: 'pr' } }>,
): boolean => {
  const context = result.source?.kind === 'pr' ? result.readContext : undefined;
  return result.source?.kind === 'pr'
    && result.source.number === target.source.number
    && (result.source.revision ?? null) === (target.source.revision?.toLowerCase() ?? null)
    && context !== undefined
    && hasSameSourceControlReadContext(context, target.context);
};

const readWalkthroughResult = async (
  response: Response,
  target: WalkthroughTarget,
): Promise<WalkthroughResult> => {
  const result = await readJson<WalkthroughResult>(response);
  if (isPullRequestTarget(target) && !hasMatchingContext(result, target)) {
    throw new WalkthroughError('The server returned a walkthrough for a different source-control context');
  }
  return result;
};

interface WalkthroughQuery {
  [key: string]: string | undefined;
  directory: string;
  source: string;
  provider?: string;
  instance?: string;
  accountId?: string;
  repositoryId?: string;
  bindingRevision?: string;
  primaryRemote?: string;
  model?: string;
  language?: string;
}

interface WalkthroughReadContextBody {
  provider?: SourceControlReadContext['provider'];
  instance?: string;
  accountId?: string;
  repositoryId?: string;
  bindingRevision?: number;
  primaryRemote?: string;
}

interface GenerateWalkthroughBody extends WalkthroughReadContextBody {
  directory: string;
  source: WalkthroughTarget['source'];
  force: boolean;
  model?: string;
  providerID?: string;
  modelID?: string;
  language?: string;
}

interface CancelWalkthroughBody extends WalkthroughReadContextBody {
  directory: string;
  source: WalkthroughTarget['source'];
}

interface WalkthroughProgressResult {
  stage?: unknown;
  readContext?: SourceControlReadContext;
}

const readContextFields = (context: Readonly<SourceControlReadContext>) => ({
  provider: context.provider,
  instance: context.instance,
  accountId: context.accountId,
  repositoryId: context.repositoryId,
  bindingRevision: context.bindingRevision,
  primaryRemote: context.primaryRemote,
});

export const buildTargetQuery = (directory: string, target: WalkthroughTarget): WalkthroughQuery => {
  const query: WalkthroughQuery = { directory, source: JSON.stringify(target.source) };
  if (isPullRequestTarget(target)) {
    const context = readContextFields(target.context);
    Object.assign(query, context, { bindingRevision: String(context.bindingRevision) });
  }
  return query;
};

export async function fetchWalkthrough(
  directory: string,
  target: WalkthroughTarget,
  options: { model?: string; providerID?: string; modelID?: string; language?: string; signal?: AbortSignal } = {}
): Promise<WalkthroughResult> {
  const query = buildTargetQuery(directory, target);
  if (options.model) query.model = options.model;
  if (options.providerID) query.providerID = options.providerID;
  if (options.modelID) query.modelID = options.modelID;
  if (options.language) query.language = options.language;
  const response = await runtimeFetch(BASE, {
    query,
    signal: options.signal,
  });
  if (!response.ok) {
    return throwFromResponse(response, 'Failed to load walkthrough');
  }
  return readWalkthroughResult(response, target);
}

export async function generateWalkthrough(
  directory: string,
  target: WalkthroughTarget,
  options: { force?: boolean; model?: string; providerID?: string; modelID?: string; language?: string; signal?: AbortSignal } = {}
): Promise<WalkthroughResult> {
  const body: GenerateWalkthroughBody = {
    directory,
    source: target.source,
    force: options.force === true,
  };
  if (isPullRequestTarget(target)) Object.assign(body, readContextFields(target.context));
  if (options.model) body.model = options.model;
  if (options.providerID) body.providerID = options.providerID;
  if (options.modelID) body.modelID = options.modelID;
  if (options.language) body.language = options.language;
  const response = await runtimeFetch(`${BASE}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
    directory,
  });
  if (!response.ok) {
    return throwFromResponse(response, 'Failed to generate walkthrough');
  }
  return readWalkthroughResult(response, target);
}

export async function cancelWalkthroughGeneration(
  directory: string,
  target: WalkthroughTarget
): Promise<void> {
  const body: CancelWalkthroughBody = { directory, source: target.source };
  if (isPullRequestTarget(target)) Object.assign(body, readContextFields(target.context));
  const response = await runtimeFetch(`${BASE}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    directory,
  });
  if (!response.ok) {
    await throwFromResponse(response, 'Failed to cancel walkthrough generation');
  }
  const result = await readJson<{ readContext?: SourceControlReadContext }>(response);
  if (isPullRequestTarget(target) && (
    result.readContext === undefined
    || !hasSameSourceControlReadContext(result.readContext, target.context)
  )) {
    throw new WalkthroughError('The server returned a cancellation result for a different source-control context');
  }
}

export async function fetchWalkthroughStage(
  directory: string,
  target: WalkthroughTarget,
  signal?: AbortSignal
): Promise<WalkthroughStage | null> {
  const response = await runtimeFetch(`${BASE}/progress`, {
    query: buildTargetQuery(directory, target),
    signal,
  });
  if (!response.ok) return null;
  const payload = await readJson<WalkthroughProgressResult>(response);
  if (isPullRequestTarget(target) && (
    payload?.readContext === undefined
    || !hasSameSourceControlReadContext(payload.readContext, target.context)
  )) {
    throw new WalkthroughError('The server returned progress for a different source-control context');
  }
  return WALKTHROUGH_STAGES.find((stage) => stage === payload.stage) ?? null;
}
