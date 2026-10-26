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
 */

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

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
const inFlight = new Map<string, Promise<boolean>>();
const declined = new Set<string>();
let promptQueue: Promise<unknown> = Promise.resolve();

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
const askForTrust = (assessment: OpenCodeTrustAssessment): Promise<boolean> => new Promise<boolean>((resolve) => {
  const show = (current: OpenCodeTrustAssessment): void => {
    pendingRequest = {
      directory: current.directory,
      items: current.items,
      settle: async (choice) => {
        if (choice === 'skip') {
          declined.add(`${current.directory}\n${current.fingerprint}`);
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
        if (answer.kind === 'changed') {
          show(answer.assessment);
          return 'changed';
        }
        pendingRequest = null;
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
 */
export const requestOpenCodeTrust = (directory: string, { deliberate }: { deliberate: boolean }): Promise<boolean> => {
  const existing = inFlight.get(directory);
  if (existing) return existing;
  const request = (async () => {
    const assessment = await fetchAssessment(directory);
    if (assessment.trusted) return true;
    if (!deliberate && declined.has(`${assessment.directory}\n${assessment.fingerprint}`)) return false;
    // One prompt on screen at a time; a second folder waits for the first.
    const turn = promptQueue.then(() => askForTrust(assessment));
    promptQueue = turn.catch(() => undefined);
    return turn;
  })()
    .catch((error) => {
      console.warn('[opencode-trust] Could not check the folder:', error);
      return false;
    })
    .finally(() => inFlight.delete(directory));
  inFlight.set(directory, request);
  return request;
};

// Matched at the end: a runtime may serve the API under a base path.
const DELIBERATE_ACTION = /\/api\/(?:session|(?:experimental\/)?session\/[^/]+\/(?:prompt|command|shell|skill))$/;

/** Whether a refused request is one the user just made rather than a background read. */
export const isDeliberateOpenCodeRequest = (method: string, pathname: string): boolean => (
  method === 'POST' && DELIBERATE_ACTION.test(pathname.replace(/\/+$/, ''))
);
