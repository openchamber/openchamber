import { z } from 'zod';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { readLead } from './metadata.js';
import { OPERATOR_CHILD_KIND } from '../session-lineage.js';
import type { LeadBriefStore } from './brief-store.js';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import type { TranslatedEvent } from '../event-stream/translate-v2.js';
import type { LeadDigest } from './metadata.js';

export const SLEEP_COMPACTION_MIN_TOKENS = 200_000;
const SLEEP_COMPACTION_WINDOW_SHARE = 0.75;
const DEFAULT_CACHE_LIFETIME_MS = 60 * 60 * 1000;
const CLAUDE_CACHE_LIFETIME_MS = 5 * 60 * 1000;
const AFTER_CACHE_MS = 30 * 1000;
const READ_TIMEOUT_MS = 10 * 1000;
const PENDING_TTL_MS = 2 * 60 * 1000;

export interface LeadChild {
  id: string;
  title?: string | undefined;
  status?: { type: string } | undefined;
}

export interface LeadModel {
  id: string;
  providerID: string;
  family: string | null;
  modelID: string | null;
  cacheLifetimeMs: number | null;
  window: number | null;
}

export interface SessionLeadRuntimeOptions {
  briefs: Pick<LeadBriefStore, 'read' | 'remove'>;
  readSessionMetadata: (sessionId: string, options: { directory: string }) => Promise<SessionMetadata | null | undefined>;
  buildOpenCodeUrl: (route: string, directory: string) => string | URL;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  readModel: (sessionId: string, directory: string) => Promise<LeadModel | null>;
  isSessionWarm?: ((sessionId: string, cacheLifetimeMs: number) => boolean) | undefined;
  listChildren: (sessionId: string) => Promise<LeadChild[]>;
  clearInherited: (sessionId: string, parentId: string, directory: string) => Promise<{ changed: boolean }>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  warn?: (...args: unknown[]) => void;
}

const metadataLinkSchema = z.object({ openchamber: z.object({ kind: z.enum(['workflow-agent', OPERATOR_CHILD_KIND]), parentID: z.string() }) });

const sessionEventSchema = z.object({
  type: z.enum(['session.idle', 'session.deleted', 'session.status', 'session.created']),
  properties: z.object({
    sessionID: z.string().min(1),
    status: z.object({ type: z.string() }).optional(),
    info: z.object({ parentID: z.string().optional(), metadata: metadataLinkSchema.optional().catch(undefined) }).optional(),
  }),
});

const tokensSchema = z.object({
  input: z.number().catch(0),
  output: z.number().catch(0),
  reasoning: z.number().catch(0),
  cache: z.object({ read: z.number().catch(0), write: z.number().catch(0) }).catch({ read: 0, write: 0 }),
});
const contextSchema = z.array(z.object({ type: z.string(), tokens: tokensSchema.optional() }).passthrough());
const activeSchema = z.record(z.string(), z.unknown());
const revertSchema = z.object({ revert: z.unknown().optional() });

const sleepLifetime = (model: LeadModel | null) => {
  if (model?.cacheLifetimeMs) return model.cacheLifetimeMs;
  const isClaude = model !== null && (model.providerID === 'claude-agent' || [model.id, model.family, model.modelID].some((name) => name?.includes('claude')));
  return isClaude ? CLAUDE_CACHE_LIFETIME_MS : DEFAULT_CACHE_LIFETIME_MS;
};

const sleepThreshold = (window: number | null) => (
  window === null ? SLEEP_COMPACTION_MIN_TOKENS : Math.min(SLEEP_COMPACTION_MIN_TOKENS, window * SLEEP_COMPACTION_WINDOW_SHARE)
);

const formatList = (items: readonly string[]) => items.map((item) => `- ${item}`).join('\n');

export const sleepSummaryText = ({ sessionId, digest, children }: { sessionId: string; digest: LeadDigest | undefined; children: LeadChild[] | null }) => {
  const sections = [
    'This lead slept past its prompt cache, so OpenChamber replaced the conversation before this point with this note instead of a model-written summary.'
      + ` The brief and the lead rules are still in your context, and the earlier conversation stays readable with session.messages for sessionId ${sessionId}`
      + ' as the lead rules describe. Read it when something below is not enough to go on.',
  ];
  if (digest) {
    if (digest.needsYou.length > 0) {
      sections.push(`Waiting on the user, as the digest last said:\n${formatList(digest.needsYou.map(({ question, recommended }) => (recommended ? `${question} (you recommended: ${recommended})` : question)))}`);
    }
    if (digest.now.length > 0) sections.push(`Where each strand stood:\n${formatList(digest.now)}`);
    if (digest.news.length > 0) sections.push(`News you had for the user:\n${formatList(digest.news)}`);
    if (digest.suggestions.length > 0) sections.push(`Work you offered the user next:\n${formatList(digest.suggestions)}`);
  } else {
    sections.push('The digest was never written.');
  }
  if (children === null) {
    sections.push('The sessions you created with ownWork could not be read just now; session.list with mine: true lists them.');
  } else if (children.length > 0) {
    sections.push(`Sessions you created with ownWork, not archived:\n${formatList(children.map((child) => `${child.title || child.id} (${child.id}): ${child.status?.type ?? 'unknown'}`))}`);
  }
  return sections.join('\n\n');
};

export const createSessionLeadRuntime = ({
  briefs,
  readSessionMetadata,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readModel,
  isSessionWarm,
  listChildren,
  clearInherited,
  fetchImpl = fetch,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  warn = (...args) => console.warn(...args),
}: SessionLeadRuntimeOptions) => {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const generations = new Map<string, number>();
  const pending = new Map<string, { at: number; digest: LeadDigest | undefined }>();

  const nextGeneration = (sessionId: string) => {
    const generation = (generations.get(sessionId) ?? 0) + 1;
    generations.set(sessionId, generation);
    return generation;
  };
  const isCurrent = (sessionId: string, generation: number) => generations.get(sessionId) === generation;

  const cancel = (sessionId: string) => {
    const timer = timers.get(sessionId);
    if (timer) clearTimer(timer);
    timers.delete(sessionId);
    nextGeneration(sessionId);
  };

  const request = async (route: string, directory: string, init: RequestInit = {}) => {
    const response = await fetchImpl(buildOpenCodeUrl(route, ''), {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-opencode-directory': encodeURIComponent(directory),
        ...getOpenCodeAuthHeaders(),
      },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`OpenCode answered ${response.status} for ${route}`);
    }
    return unwrapOpenCodeResponse(await response.json());
  };

  const contextTokens = async (sessionId: string, directory: string) => {
    const messages = contextSchema.parse(await request(`/api/session/${encodeURIComponent(sessionId)}/context`, directory));
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.type !== 'assistant' || !message.tokens) continue;
      const { input, output, reasoning, cache } = message.tokens;
      return input + output + reasoning + cache.read + cache.write;
    }
    return 0;
  };

  const isBusy = async (sessionId: string) => Boolean(activeSchema.parse(await request('/api/session/active', ''))[sessionId]);
  const hasStagedRevert = async (sessionId: string, directory: string) => (
    revertSchema.parse(await request(`/api/session/${encodeURIComponent(sessionId)}`, directory)).revert != null
  );

  const sleep = async (sessionId: string, directory: string, cacheLifetimeMs: number, generation: number) => {
    const model = await readModel(sessionId, directory).catch(() => null);
    if (await contextTokens(sessionId, directory) < sleepThreshold(model?.window ?? null)) return;
    if (!isCurrent(sessionId, generation) || isSessionWarm?.(sessionId, cacheLifetimeMs)) return;
    const lead = readLead(await readSessionMetadata(sessionId, { directory }));
    if (!lead) return;
    const hasBrief = await briefs.read(sessionId).then((brief) => brief !== null, (error: Error) => {
      warn('[session-lead] could not read the brief before sleeping; the model writes the summary:', error.message);
      return false;
    });
    if (await hasStagedRevert(sessionId, directory) || await isBusy(sessionId)) return;
    if (!isCurrent(sessionId, generation)) return;
    if (hasBrief) pending.set(sessionId, { at: now(), digest: lead.digest });
    try {
      await request(`/api/session/${encodeURIComponent(sessionId)}/compact`, directory, { method: 'POST', body: JSON.stringify({}) });
    } catch (error) {
      pending.delete(sessionId);
      throw error;
    }
  };

  const arm = async (sessionId: string, directory: string) => {
    cancel(sessionId);
    const generation = generations.get(sessionId) ?? 0;
    const lead = readLead(await readSessionMetadata(sessionId, { directory }).catch(() => undefined));
    if (!lead) return;
    const lifetime = sleepLifetime(await readModel(sessionId, directory).catch(() => null));
    if (!isCurrent(sessionId, generation)) return;
    timers.set(sessionId, setTimer(() => {
      timers.delete(sessionId);
      if (!isCurrent(sessionId, generation)) return;
      return sleep(sessionId, directory, lifetime, generation)
        .catch((error) => warn('[session-lead] sleep compaction failed:', error instanceof Error ? error.message : String(error)));
    }, lifetime + AFTER_CACHE_MS));
  };

  const processPayload = (payload: TranslatedEvent, directory: string) => {
    const event = sessionEventSchema.safeParse(payload);
    if (!event.success) return;
    const { sessionID, status, info } = event.data.properties;
    if (event.data.type === 'session.created') {
      if (info?.parentID && info.metadata?.openchamber.parentID !== info.parentID) {
        void clearInherited(sessionID, info.parentID, directory).catch((error) => warn('[session-lead] could not clear what a child copied from its parent:', error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    if (event.data.type === 'session.deleted') {
      cancel(sessionID);
      generations.delete(sessionID);
      pending.delete(sessionID);
      void briefs.remove(sessionID).catch((error) => warn('[session-lead] could not remove a deleted lead\'s brief:', error instanceof Error ? error.message : String(error)));
      return;
    }
    if (event.data.type === 'session.status') {
      if (status?.type === 'busy' || status?.type === 'retry') cancel(sessionID);
      return;
    }
    void arm(sessionID, directory);
  };

  const sleepSummary = async (sessionId: string) => {
    const entry = pending.get(sessionId);
    pending.delete(sessionId);
    if (!entry || now() - entry.at > PENDING_TTL_MS) return null;
    const children = await listChildren(sessionId).catch(() => null);
    return sleepSummaryText({ sessionId, digest: entry.digest, children });
  };

  const stop = () => {
    for (const sessionId of [...timers.keys()]) cancel(sessionId);
  };

  return { processPayload, sleepSummary, isBusy, stop };
};
