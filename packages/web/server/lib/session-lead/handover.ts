import { z } from 'zod';
import { admitOperatorChildNote, OPERATOR_CHILD_DENIED_RULES, operatorChildMetadata, withoutOperatorChildDenials } from '../openchamber-sessions/create-session.js';
import { readLead } from './metadata.js';
import { createOneAtATime } from './one-at-a-time.js';
import type { MetadataDecider, SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import type { SessionClient } from '../openchamber-sessions/opencode-client-contract.js';

export const HANDOVER_NOTE_SOURCE = 'openchamber-lead-handover';

const linkSchema = z.object({ openchamber: z.object({ kind: z.string(), parentID: z.string() }) });
const recordsSchema = z.object({ data: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()).catch([]) });

interface LeadHandoverOptions {
  resolveSessionDirectory: (sessionId: string) => Promise<string | null>;
  readSessionMetadata: (sessionId: string, options: { directory: string }) => Promise<SessionMetadata | null | undefined>;
  updateMetadata: (sessionId: string, decide: MetadataDecider, directory: string) => Promise<{ changed: boolean }>;
  openCode: (directory: string) => SessionClient;
  isBusy: (sessionId: string) => Promise<boolean>;
  registerResult: (entry: { parentSessionId: string; sessionId: string; dispatchedAt: number; afterIdleId: string | null }) => Promise<{ id: string }>;
  createError: (message: string, status: number) => Error;
  warn?: (...args: unknown[]) => void;
  now?: () => number;
}

export const handoverText = ({ title, sessionId, running }: { title: string; sessionId: string; running: boolean }) => [
  `The user handed you the session "${title}" (${sessionId}). It is one of your sessions now, as if you had created it with ownWork: it nests under you, the user no longer talks to it, and it cannot ask questions with tools.`,
  'Read it with session.messages, work out the result it was going for, and take that result to the end the way you run any strand: continue it with session.send and returnResult, or hand the rest to a new child.'
    + ' Ask the user only what its conversation leaves open by your usual rule. Add the strand to the brief and the digest.',
  running
    ? "It is running right now. Its answer comes to you when this turn of it ends; if it doesn't, read it with session.messages once it is idle."
    : 'It is not running right now.',
].join('\n\n');

export const createLeadHandover = ({
  resolveSessionDirectory,
  readSessionMetadata,
  updateMetadata,
  openCode,
  isBusy,
  registerResult,
  createError,
  warn = (...args) => console.warn(...args),
  now = Date.now,
}: LeadHandoverOptions) => {
  const oneHandoverAtATime = createOneAtATime();

  const readSession = async (sessionId: string) => {
    const directory = await resolveSessionDirectory(sessionId);
    if (!directory) throw createError(`Session not found: ${sessionId}`, 404);
    return { directory, metadata: await readSessionMetadata(sessionId, { directory }) };
  };

  const latestIdleId = async (client: SessionClient, sessionId: string) => {
    const records = recordsSchema.parse(await client.message.list({ sessionID: sessionId, limit: 100, order: 'desc' })).data;
    return records.find((record) => record.type === 'idle')?.id ?? null;
  };

  const adopt = async (client: SessionClient, sessionId: string, leadId: string, directory: string) => {
    const info = await client.session.get({ sessionID: sessionId });
    if (info.parentID) throw createError('A subagent session belongs to the session that started it', 409);
    const permissions = withoutOperatorChildDenials(info.permissions);
    const restorePermissions = () => client.session.update({ sessionID: sessionId, permissions: info.permissions ?? [] })
      .catch((error: Error) => warn('[session-lead] could not restore the permissions of', sessionId, error.message));
    await client.session.update({ sessionID: sessionId, permissions: [...permissions, ...OPERATOR_CHILD_DENIED_RULES] });
    const link: MetadataDecider = (current) => (readLead(current) || linkSchema.safeParse(current).success ? null : { openchamber: operatorChildMetadata(leadId) });
    const linked = await updateMetadata(sessionId, link, directory).catch(async (error: Error) => {
      await restorePermissions();
      throw error;
    });
    if (!linked.changed) {
      await restorePermissions();
      throw createError('The session changed just now: it became a lead or another session runs it', 409);
    }
    const undo = async () => {
      const unlinked = await updateMetadata(sessionId, (current) => (linkSchema.safeParse(current).data?.openchamber.parentID === leadId
        ? { openchamber: { kind: null, parentID: null } }
        : null), directory).then(() => true, (error: Error) => {
        warn('[session-lead] could not unlink', sessionId, error.message);
        return false;
      });
      if (unlinked) await restorePermissions();
    };
    return { title: info.title || sessionId, undo };
  };

  const handOver = (sessionId: string, leadId: string) => oneHandoverAtATime(sessionId, async () => {
    if (sessionId === leadId) throw createError('A lead cannot be handed to itself', 400);
    const lead = await readSession(leadId);
    if (!readLead(lead.metadata)) throw createError('That session is not a lead', 409);
    const leadClient = openCode(lead.directory);
    if ((await leadClient.session.get({ sessionID: leadId })).revert) {
      throw createError('The lead has an undo waiting. Open the lead and finish or cancel it first.', 409);
    }
    const session = await readSession(sessionId);
    if (readLead(session.metadata)) throw createError('A lead cannot be handed to another lead. Make it an ordinary session first.', 409);
    if (linkSchema.safeParse(session.metadata).success) throw createError('Another session runs this one. Take it over first.', 409);

    const client = openCode(session.directory);
    const lastIdleId = await latestIdleId(client, sessionId).catch(() => undefined);
    const running = await isBusy(sessionId).catch(() => false);
    const { title, undo } = await adopt(client, sessionId, leadId, session.directory);
    try {
      await leadClient.session.synthetic({
        sessionID: leadId,
        text: handoverText({ title, sessionId, running }),
        description: `Handed over: ${title}`,
        metadata: { source: HANDOVER_NOTE_SOURCE, sessionID: sessionId, title },
        resume: true,
      });
    } catch (error) {
      await undo();
      throw error;
    }
    await admitOperatorChildNote(client, sessionId, leadId);
    if (running && lastIdleId !== undefined) {
      await registerResult({ parentSessionId: leadId, sessionId, dispatchedAt: now(), afterIdleId: lastIdleId })
        .catch((error: Error) => warn('[session-lead] the handed-over session\'s answer will not reach its lead:', error.message));
    }
    return { sessionId, leadId };
  });

  return { handOver };
};
