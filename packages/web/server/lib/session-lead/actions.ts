import { z } from 'zod';
import { BRIEF_MAX_LENGTH } from './brief-store.js';
import { digestPatch, parseDigestInput, readLead, sectionInputSchema } from './metadata.js';
import type { MetadataDecider, SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import type { ControlInput } from '../openchamber-control/contracts.js';
import type { LeadBriefStore } from './brief-store.js';

interface LeadSession {
  id: string;
  metadata: SessionMetadata | null | undefined;
  directory: string;
}

export interface LeadActionDependencies {
  getSession: (sessionId: string) => Promise<LeadSession | null>;
  updateMetadata: (sessionId: string, decide: MetadataDecider, directory: string) => Promise<{ changed: boolean }>;
  briefs: Pick<LeadBriefStore, 'read' | 'write'>;
  syncBriefEntry: (sessionId: string, directory: string, brief: string) => Promise<boolean>;
  createError: (message: string, status: number) => Error;
  now?: () => number;
}

type LeadActionInput = Pick<ControlInput, 'brief' | 'needsYou' | 'now' | 'news'>;

const briefInputSchema = z.object({ brief: z.string().optional() });
const digestInputSchema = z.object({ needsYou: sectionInputSchema, now: sectionInputSchema, news: sectionInputSchema });

export const createLeadActions = ({ getSession, updateMetadata, briefs, syncBriefEntry, createError, now = Date.now }: LeadActionDependencies) => {
  const requireLead = async (sessionId: string | null) => {
    if (!sessionId) throw createError('Call this from the lead session itself', 400);
    const session = await getSession(sessionId);
    if (!session) throw createError(`Session not found: ${sessionId}`, 404);
    if (!readLead(session.metadata)) {
      throw createError('This session is not a lead. Only the user makes a session a lead, from its menu or with New lead.', 409);
    }
    return session;
  };

  const brief = async (sessionId: string | null, input: LeadActionInput) => {
    const parsed = briefInputSchema.safeParse(input);
    if (!parsed.success) throw createError('brief must be the whole brief as markdown text', 400);
    const session = await requireLead(sessionId);
    if (parsed.data.brief === undefined) {
      const body = await briefs.read(session.id);
      return { sessionId: session.id, brief: body ?? '', limit: BRIEF_MAX_LENGTH, empty: body === null };
    }
    const body = parsed.data.brief.trim();
    if (!body) throw createError('brief is empty. Send the whole brief; there is nothing to clear it with.', 400);
    if (body.length > BRIEF_MAX_LENGTH) {
      throw createError(`The brief is ${body.length} characters; the limit is ${BRIEF_MAX_LENGTH}. Condense it: rules and outcomes, not history. Nothing was saved.`, 400);
    }
    await briefs.write(session.id, `${body}\n`);
    await syncBriefEntry(session.id, session.directory, body)
      .catch((error: Error) => console.warn('[session-lead] brief entry write failed:', error.message));
    return { sessionId: session.id, saved: true, length: body.length, limit: BRIEF_MAX_LENGTH };
  };

  const digest = async (sessionId: string | null, input: LeadActionInput) => {
    const fields = digestInputSchema.safeParse(input);
    if (!fields.success) throw createError('needsYou, now and news are lists of strings. Nothing was saved.', 400);
    const session = await requireLead(sessionId);
    const parsed = parseDigestInput(fields.data, now());
    if ('error' in parsed) throw createError(`${parsed.error}. Nothing was saved.`, 400);
    const markedAt = readLead(session.metadata)?.at;
    const { changed } = await updateMetadata(session.id, (current) => (readLead(current)?.at === markedAt ? digestPatch(parsed.digest) : null), session.directory);
    if (!changed) throw createError('The user turned this session back into an ordinary one just now. Nothing was saved.', 409);
    return { sessionId: session.id, saved: true, digest: parsed.digest };
  };

  const execute = (action: string, input: LeadActionInput, contextSessionId: string | null) => {
    if (action === 'lead.brief') return brief(contextSessionId, input);
    if (action === 'lead.digest') return digest(contextSessionId, input);
    throw createError(`Unsupported lead action: ${action}`, 400);
  };

  return { execute };
};
