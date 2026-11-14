/**
 * The trust prompt for a folder's OpenCode configuration.
 *
 * OpenCode runs a folder's plugins and starts the commands in its
 * configuration (MCP servers, language servers, formatters) the moment it
 * opens the folder. The server refuses OpenCode requests for a folder whose
 * configuration runs code until the user trusts exactly that configuration
 * (`packages/web/server/lib/opencode-trust`), answering 403 with
 * `opencode_trust_required`. The OpenCode client hands such an answer here:
 * the app shows what would run, records a "trust" answer on the server, and
 * the client sends the request again.
 *
 * Requests for one folder share one prompt. "Not this time" keeps the folder
 * closed and stops background reads from asking again until the user opens a
 * folder; a deliberate action (a new session, a message) asks again.
 * The folder stays paused (`isOpenCodeTrustPaused`) until trust is saved, so
 * the sidebar and the composer can offer the prompt again.
 */

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { runBackgroundNetworkTask } from '@/lib/background-network';

const OPENCODE_TRUST_ROUTE = '/api/opencode/trust';
const OPENCODE_TRUST_REQUIRED = 'opencode_trust_required';

const itemSchema = z.object({
  kind: z.enum(['plugin', 'package', 'mcp', 'lsp', 'formatter', 'shell', 'config']),
  source: z.string(),
  name: z.string(),
  detail: z.string(),
});

const assessmentSchema = z.object({
  directory: z.string(),
  trusted: z.boolean(),
  fingerprint: z.string().nullable(),
  items: z.array(itemSchema),
});

const refusalSchema = z.object({ code: z.literal(OPENCODE_TRUST_REQUIRED), directory: z.string() });

export type OpenCodeTrustItem = z.infer<typeof itemSchema>;
type OpenCodeTrustAssessment = z.infer<typeof assessmentSchema>;

export type OpenCodeTrustChoice = 'trust' | 'skip';
/**
 * What an answer came to. `failed` keeps the prompt on screen; `changed`
 * shows the configuration again because it changed while on screen.
 */
type OpenCodeTrustOutcome = 'saved' | 'failed' | 'changed' | 'skipped';

type PendingOpenCodeTrustRequest = {
  directory: string;
  items: OpenCodeTrustItem[];
  settle: (choice: OpenCodeTrustChoice) => Promise<OpenCodeTrustOutcome>;
};

let pendingRequest: PendingOpenCodeTrustRequest | null = null;
const listeners = new Set<() => void>();
// The spellings of the folder every caller asked with, joined callers too.
const inFlight = new Map<string, { request: Promise<boolean>; spellings: Set<string> }>();
const declined = new Set<string>();
// Folders whose last prompt the user declined, under every spelling the app
// asked with and the server's resolved one (a symlink differs), each mapped to
// the resolved one. Unlike `declined`, opening another folder keeps them: they
// stay paused until OpenCode opens the folder.
const paused = new Map<string, string>();
let promptQueue: Promise<unknown> = Promise.resolve();
let runtimeGeneration = 0;

const emitChange = (): void => {
  for (const listener of listeners) listener();
};

export const getOpenCodeTrustSnapshot = (): PendingOpenCodeTrustRequest | null => pendingRequest;

export const subscribeOpenCodeTrust = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Answer the prompt on screen. A "trust" that fails to save keeps it on screen. */
export const settleOpenCodeTrust = (choice: OpenCodeTrustChoice): Promise<OpenCodeTrustOutcome> => (
  pendingRequest ? pendingRequest.settle(choice) : Promise.resolve('skipped')
);

subscribeRuntimeEndpointWillChange(() => {
  runtimeGeneration += 1;
  void pendingRequest?.settle('skip');
  inFlight.clear();
  declined.clear();
  paused.clear();
  promptQueue = Promise.resolve();
  emitChange();
});

/** Whether the user declined to trust `directory`, so OpenCode stays closed there. */
export const isOpenCodeTrustPaused = (directory: string | null | undefined): boolean => (
  directory ? paused.has(directory) : false
);

const pauseFolder = (resolved: string, spellings: Iterable<string>): void => {
  paused.set(resolved, resolved);
  for (const spelling of spellings) paused.set(spelling, resolved);
};

/**
 * Lifts the pause of `directory` under all its spellings: trust was saved, or
 * OpenCode answered for the folder, which it does only once trusted (from
 * another window too).
 */
export const clearOpenCodeTrustPause = (directory: string): void => {
  const resolved = paused.get(directory);
  if (resolved === undefined) return;
  for (const [spelling, target] of paused) {
    if (target === resolved) paused.delete(spelling);
  }
  emitChange();
};

/** Opening a folder asks again for any folder the user declined before. */
export const forgetOpenCodeTrustDeclines = (): void => {
  declined.clear();
};

/** The folder a refused OpenCode response names, or null for any other response. */
export const openCodeTrustRefusalDirectory = async (response: Response): Promise<string | null> => {
  if (response.status !== 403) return null;
  try {
    const parsed = refusalSchema.safeParse(await response.clone().json());
    return parsed.success ? parsed.data.directory : null;
  } catch {
    return null;
  }
};

const readAssessment = async (response: Response): Promise<OpenCodeTrustAssessment> => (
  assessmentSchema.parse(await response.json())
);

const fetchAssessment = async (directory: string): Promise<OpenCodeTrustAssessment> => {
  const response = await runtimeFetch(OPENCODE_TRUST_ROUTE, { query: { directory } });
  if (!response.ok) throw new Error(`Folder trust check answered ${response.status}`);
  return readAssessment(response);
};

type TrustAnswer = { kind: 'trusted' } | { kind: 'changed'; assessment: OpenCodeTrustAssessment };

const recordTrust = async (assessment: OpenCodeTrustAssessment): Promise<TrustAnswer> => {
  const response = await runtimeFetch(OPENCODE_TRUST_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directory: assessment.directory, fingerprint: assessment.fingerprint }),
  });
  if (response.status === 409) return { kind: 'changed', assessment: await readAssessment(response) };
  if (!response.ok) throw new Error(`Saving folder trust answered ${response.status}`);
  return { kind: 'trusted' };
};

/**
 * Shows `assessment` and resolves true once its trust is saved, false when
 * the user declines. Configuration that changed while on screen is shown
 * again with the new contents.
 */
const askForTrust = (assessment: OpenCodeTrustAssessment, generation: number, spellings: ReadonlySet<string>): Promise<boolean> => new Promise<boolean>((resolve) => {
  const show = (current: OpenCodeTrustAssessment): void => {
    if (generation !== runtimeGeneration) { resolve(false); return; }
    pendingRequest = {
      directory: current.directory,
      items: current.items,
      settle: async (choice) => {
        if (choice === 'skip') {
          declined.add(`${current.directory}\n${current.fingerprint}`);
          pauseFolder(current.directory, spellings);
          pendingRequest = null;
          emitChange();
          resolve(false);
          return 'skipped';
        }
        let answer: TrustAnswer;
        try {
          answer = await recordTrust(current);
        } catch (error) {
          console.warn('[opencode-trust] Failed to save the answer:', error);
          return 'failed';
        }
        if (generation !== runtimeGeneration) return 'skipped';
        if (answer.kind === 'changed') {
          show(answer.assessment);
          return 'changed';
        }
        pendingRequest = null;
        clearOpenCodeTrustPause(current.directory);
        emitChange();
        resolve(true);
        return 'saved';
      },
    };
    emitChange();
  };
  show(assessment);
});

/**
 * Make sure OpenCode may open `directory`, asking the user when it may not.
 * Resolves true when the request that was refused can be sent again.
 * `deliberate` marks a request the user just made, which asks even after a
 * "Not this time" for the same configuration.
 * Admission uses `throwOnError` to retry read failures separately from declines.
 * `alias` is the spelling the app asked with when `directory` is the server's.
 */
export const requestOpenCodeTrust = (directory: string, { deliberate, background = false, throwOnError = false, alias }: { deliberate: boolean; background?: boolean; throwOnError?: boolean; alias?: string }): Promise<boolean> => {
  const resultForCaller = (request: Promise<boolean>): Promise<boolean> => throwOnError ? request : request.catch((error) => {
    console.warn('[opencode-trust] Could not check the folder:', error);
    return false;
  });
  const existing = inFlight.get(directory);
  if (existing) {
    if (alias) existing.spellings.add(alias);
    return resultForCaller(existing.request);
  }
  const spellings = new Set([directory, ...(alias ? [alias] : [])]);
  // A declined folder stays paused under every spelling that asks for it.
  const stillDeclined = (resolved: string): false => {
    if (paused.has(resolved) && [...spellings].some((spelling) => !paused.has(spelling))) {
      pauseFolder(resolved, spellings);
      emitChange();
    }
    return false;
  };
  const generation = runtimeGeneration;
  const request = (async () => {
    const assessment = await (background
      ? runBackgroundNetworkTask(() => generation === runtimeGeneration ? fetchAssessment(directory) : Promise.resolve(null))
      : fetchAssessment(directory));
    if (!assessment || generation !== runtimeGeneration) return false;
    if (assessment.trusted) {
      // Trusted meanwhile, from another window or client.
      clearOpenCodeTrustPause(assessment.directory);
      return true;
    }
    if (!deliberate && declined.has(`${assessment.directory}\n${assessment.fingerprint}`)) return stillDeclined(assessment.directory);
    // Another worktree may be trusted while this folder waits its turn.
    const turn = promptQueue.then(async () => {
      if (generation !== runtimeGeneration) return false;
      const current = await fetchAssessment(directory);
      if (generation !== runtimeGeneration) return false;
      if (current.trusted) {
        clearOpenCodeTrustPause(current.directory);
        return true;
      }
      if (!deliberate && declined.has(`${current.directory}\n${current.fingerprint}`)) return stillDeclined(current.directory);
      return askForTrust(current, generation, spellings);
    });
    promptQueue = turn.catch(() => undefined);
    return turn;
  })().finally(() => { if (inFlight.get(directory)?.request === request) inFlight.delete(directory); });
  inFlight.set(directory, { request, spellings });
  return resultForCaller(request);
};

/**
 * Whether OpenCode stays closed for `directory` until the user trusts its
 * configuration. A failed check answers false.
 */
export const isOpenCodeTrustPending = async (directory: string): Promise<boolean> => {
  try {
    const assessment = await fetchAssessment(directory);
    if (assessment.trusted) clearOpenCodeTrustPause(assessment.directory);
    return !assessment.trusted;
  } catch {
    return false;
  }
};

// Matched at the end: a runtime may serve the API under a base path.
const DELIBERATE_ACTION = /\/api\/(?:session|(?:experimental\/)?session\/[^/]+\/(?:prompt|command|shell|skill|move))$/;

/** Whether a refused request is one the user just made rather than a background read. */
export const isDeliberateOpenCodeRequest = (method: string, pathname: string): boolean => (
  method === 'POST' && DELIBERATE_ACTION.test(pathname.replace(/\/+$/, ''))
);
