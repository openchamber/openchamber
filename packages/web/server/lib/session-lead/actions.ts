import { z } from 'zod';
import { BRIEF_MAX_LENGTH } from './brief-store.js';
import { digestPatch, parseDigestInput, readLead, sectionInputSchema, withoutDismissed } from './metadata.js';
import { createOneAtATime } from './one-at-a-time.js';
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
  handOver: (sessionId: string, leadId: string) => Promise<{ sessionId: string; leadId: string }>;
  createError: (message: string, status: number) => Error;
  now?: () => number;
}

type LeadActionInput = Pick<ControlInput, 'brief' | 'edits' | 'needsYou' | 'now' | 'news' | 'suggestions' | 'sessionId' | 'leadId'>;

const editSchema = z.object({ find: z.string().min(1), replace: z.string() });
const editsSchema = z.union([
  z.array(editSchema),
  z.string().transform((text, context) => {
    try {
      return JSON.parse(text);
    } catch {
      context.addIssue({ code: 'custom', message: 'not a JSON list of edits' });
      return z.NEVER;
    }
  }).pipe(z.array(editSchema)),
]);
const briefInputSchema = z.object({ brief: z.string().optional(), edits: editsSchema.optional() });
const handoverInputSchema = z.object({ sessionId: z.string().min(1), leadId: z.string().min(1) });
const digestInputSchema = z.object({ needsYou: sectionInputSchema, now: sectionInputSchema, news: sectionInputSchema, suggestions: sectionInputSchema });

const READ_FIRST = 'Read the brief with lead.brief and no arguments, then edit what it says now. Nothing was saved.';

const applyEdits = (body: string, edits: readonly z.infer<typeof editSchema>[]): { body: string } | { error: string } => {
  let result = body;
  for (const [index, edit] of edits.entries()) {
    const first = result.indexOf(edit.find);
    if (first === -1) return { error: `Edit ${index + 1}: its find text is not in the brief. ${READ_FIRST}` };
    if (result.indexOf(edit.find, first + 1) !== -1) return { error: `Edit ${index + 1}: its find text appears more than once; include more of the surrounding text. Nothing was saved.` };
    result = result.slice(0, first) + edit.replace + result.slice(first + edit.find.length);
  }
  return { body: result };
};

export const createLeadActions = ({ getSession, updateMetadata, briefs, handOver, createError, now = Date.now }: LeadActionDependencies) => {
  const oneBriefWriteAtATime = createOneAtATime();
  const requireLead = async (sessionId: string | null) => {
    if (!sessionId) throw createError('Call this from the lead session itself', 400);
    const session = await getSession(sessionId);
    if (!session) throw createError(`Session not found: ${sessionId}`, 404);
    if (!readLead(session.metadata)) {
      throw createError('This session is not a lead. Only the user makes a session a lead, from its menu or with New lead.', 409);
    }
    return session;
  };

  const nextBrief = async (sessionId: string, input: z.infer<typeof briefInputSchema>) => {
    if (input.brief !== undefined && input.edits !== undefined) throw createError('Send either brief, the whole text, or edits, not both. Nothing was saved.', 400);
    if (input.brief !== undefined) return input.brief;
    const current = await briefs.read(sessionId);
    if (current === null) throw createError('There is no brief yet to edit. Write the whole brief with brief. Nothing was saved.', 409);
    const edited = applyEdits(current, input.edits ?? []);
    if ('error' in edited) throw createError(edited.error, 409);
    return edited.body;
  };

  const brief = async (sessionId: string | null, input: LeadActionInput) => {
    const parsed = briefInputSchema.safeParse(input);
    if (!parsed.success) throw createError('brief is the whole brief as markdown text; edits is a list of { find, replace }. Nothing was saved.', 400);
    const session = await requireLead(sessionId);
    if (parsed.data.brief === undefined && parsed.data.edits === undefined) {
      const body = await briefs.read(session.id);
      return { sessionId: session.id, brief: body ?? '', limit: BRIEF_MAX_LENGTH, empty: body === null };
    }
    return oneBriefWriteAtATime(session.id, async () => {
      const body = (await nextBrief(session.id, parsed.data)).trim();
      if (!body) throw createError('That would leave the brief empty; there is nothing to clear it with. Nothing was saved.', 400);
      if (body.length > BRIEF_MAX_LENGTH) {
        throw createError(`The brief would be ${body.length} characters; the limit is ${BRIEF_MAX_LENGTH}. Condense it: rules and outcomes, not history. Nothing was saved.`, 400);
      }
      await briefs.write(session.id, `${body}\n`);
      return { sessionId: session.id, saved: true, length: body.length, limit: BRIEF_MAX_LENGTH };
    });
  };

  const digest = async (sessionId: string | null, input: LeadActionInput) => {
    const fields = digestInputSchema.safeParse(input);
    if (!fields.success) throw createError('needsYou, now, news and suggestions are lists. Nothing was saved.', 400);
    const session = await requireLead(sessionId);
    const markedAt = readLead(session.metadata)?.at;
    const parsed = parseDigestInput(fields.data, now());
    if ('error' in parsed) throw createError(`${parsed.error}. Nothing was saved.`, 400);
    let written: ReturnType<typeof withoutDismissed> = { digest: parsed.digest, dropped: [] };
    const { changed } = await updateMetadata(session.id, (current) => {
      const lead = readLead(current);
      if (lead?.at !== markedAt) return null;
      written = withoutDismissed(parsed.digest, lead?.dismissed ?? []);
      return digestPatch(written.digest);
    }, session.directory);
    if (!changed) throw createError('The user turned this session back into an ordinary one just now. Nothing was saved.', 409);
    const saved = { sessionId: session.id, saved: true, digest: written.digest };
    if (written.dropped.length === 0) return saved;
    return { ...saved, droppedFromSuggestions: written.dropped, note: 'The user dismissed these before, so they were left out. Do not offer them again.' };
  };

  const handover = async (input: LeadActionInput, contextSessionId: string | null) => {
    if (contextSessionId) throw createError('Only the user hands a session to a lead', 403);
    const parsed = handoverInputSchema.safeParse(input);
    if (!parsed.success) throw createError('sessionId and leadId are required', 400);
    return handOver(parsed.data.sessionId, parsed.data.leadId);
  };

  const execute = (action: string, input: LeadActionInput, contextSessionId: string | null) => {
    if (action === 'lead.handover') return handover(input, contextSessionId);
    if (action === 'lead.brief') return brief(contextSessionId, input);
    if (action === 'lead.digest') return digest(contextSessionId, input);
    throw createError(`Unsupported lead action: ${action}`, 400);
  };

  return { execute };
};
