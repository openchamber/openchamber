import { z } from 'zod';
import { BRIEF_MAX_LENGTH, briefFill, changeStrands, holdsStrandsSection, readBriefDocument, writeBriefDocument } from './brief-document.js';
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
  briefs: Pick<LeadBriefStore, 'pathOf' | 'read' | 'write'>;
  handOver: (sessionId: string, leadId: string) => Promise<{ sessionId: string; leadId: string }>;
  createError: (message: string, status: number) => Error;
  now?: () => number;
}

type LeadActionInput = Pick<ControlInput, 'brief' | 'edits' | 'strands' | 'needsYou' | 'now' | 'news' | 'suggestions' | 'sessionId' | 'leadId'>;

const editSchema = z.object({ find: z.string().min(1), replace: z.string() });
const strandSchema = z.union([z.object({ id: z.string(), text: z.string(), close: z.literal(false).optional() }).transform(({ id, text }) => ({ id, text })), z.object({ id: z.string(), close: z.literal(true) })]);
const listOrJson = <Item extends z.ZodType>(item: Item) => z.union([
  z.array(item),
  z.string().transform((text, context) => {
    try {
      return JSON.parse(text);
    } catch {
      context.addIssue({ code: 'custom', message: 'not a JSON list' });
      return z.NEVER;
    }
  }).pipe(z.array(item)),
]);
const briefInputSchema = z.object({ brief: z.string().optional(), edits: listOrJson(editSchema).optional(), strands: listOrJson(strandSchema).optional() });
const handoverInputSchema = z.object({ sessionId: z.string().min(1), leadId: z.string().min(1) });
const digestInputSchema = z.object({ needsYou: sectionInputSchema, now: sectionInputSchema, news: sectionInputSchema, suggestions: sectionInputSchema });

const BRIEF_FIELDS = briefInputSchema.keyof().options;
const DIGEST_FIELDS = digestInputSchema.keyof().options;
const CALL_FIELDS = ['action', 'sessionId', 'directory', 'projectId'];
const placeholderSchema = z.union([z.undefined(), z.null(), z.literal(false), z.literal(''), z.array(z.unknown()).length(0), z.strictObject({})]);

const unknownFieldError = (action: string, fields: readonly string[], input: LeadActionInput) => {
  const unknown = Object.entries(input)
    .filter(([name, value]) => !fields.includes(name) && !CALL_FIELDS.includes(name) && !placeholderSchema.safeParse(value).success)
    .map(([name]) => name);
  return unknown.length === 0 ? null : `${action} has no ${unknown.join(', ')}; it takes ${fields.join(', ')}. Nothing was saved.`;
};

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

  const nextBrief = (stored: string | null, input: z.infer<typeof briefInputSchema>) => {
    if (input.brief !== undefined && input.edits !== undefined) throw createError('Send either brief, the whole text, or edits, not both. Nothing was saved.', 400);
    if (stored === null && input.brief === undefined) throw createError('There is no brief yet to change. Write it with brief first. Nothing was saved.', 409);
    const current = readBriefDocument(stored ?? '');
    const edited = input.brief === undefined ? applyEdits(current.free, input.edits ?? []) : { body: input.brief };
    if ('error' in edited) throw createError(edited.error, 409);
    const free = edited.body.trim();
    if (!free) throw createError('That would leave the brief empty; there is nothing to clear it with. Nothing was saved.', 400);
    if (holdsStrandsSection(free)) throw createError('brief and edits change the text above the strands; the strands stay as they are. Leave the Strands section out and change it with strands. Nothing was saved.', 400);
    const changed = changeStrands(current.strands, input.strands ?? []);
    if ('error' in changed) throw createError(`${changed.error}. Nothing was saved.`, 409);
    return { document: { free, strands: changed.strands }, changed: changed.changed };
  };

  const brief = async (sessionId: string | null, input: LeadActionInput) => {
    const parsed = briefInputSchema.safeParse(input);
    if (!parsed.success) throw createError('brief is the goal, outcomes and rules as markdown text; edits is a list of { find, replace }; strands is a list of { id, text } or { id, close: true }. Nothing was saved.', 400);
    const session = await requireLead(sessionId);
    const { brief: whole, edits, strands } = parsed.data;
    if (whole === undefined && edits === undefined && strands === undefined) {
      const stored = await briefs.read(session.id);
      if (stored === null) return { sessionId: session.id, brief: '', limit: BRIEF_MAX_LENGTH, empty: true };
      const document = readBriefDocument(stored);
      return { sessionId: session.id, brief: document.free, strands: document.strands, ...briefFill(document), empty: false, file: briefs.pathOf(session.id) };
    }
    return oneBriefWriteAtATime(session.id, async () => {
      const { document, changed } = nextBrief(await briefs.read(session.id), parsed.data);
      const body = writeBriefDocument(document);
      if (body.length > BRIEF_MAX_LENGTH) {
        throw createError(`The brief would be ${body.length} characters; the limit is ${BRIEF_MAX_LENGTH}. Close finished strands and condense the rest: rules and outcomes, not history. Nothing was saved.`, 400);
      }
      await briefs.write(session.id, `${body}\n`);
      const saved = { sessionId: session.id, saved: true, ...briefFill(document), file: briefs.pathOf(session.id) };
      return strands === undefined ? saved : { ...saved, strands: changed };
    });
  };

  const digest = async (sessionId: string | null, input: LeadActionInput) => {
    const fields = digestInputSchema.safeParse(input);
    if (!fields.success) throw createError('needsYou, now, news and suggestions are lists. Nothing was saved.', 400);
    const session = await requireLead(sessionId);
    if (await briefs.read(session.id) === null) {
      throw createError('This lead has no brief yet. Write the brief with lead.brief first, then send the digest again. Nothing was saved.', 409);
    }
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

  const execute = async (action: string, input: LeadActionInput, contextSessionId: string | null) => {
    if (action === 'lead.handover') return handover(input, contextSessionId);
    if (action === 'lead.brief' || action === 'lead.digest') {
      const error = unknownFieldError(action, action === 'lead.brief' ? BRIEF_FIELDS : DIGEST_FIELDS, input);
      if (error) throw createError(error, 400);
      return action === 'lead.brief' ? brief(contextSessionId, input) : digest(contextSessionId, input);
    }
    throw createError(`Unsupported lead action: ${action}`, 400);
  };

  return { execute };
};
