import { z } from 'zod';
import type { Metadata, Session } from '@/lib/opencode/model';

/**
 * "In work", stored under `session.metadata.openchamber.work`. The server's
 * session-work runtime opens a session when Jev sees real work start and
 * stamps `suggestDoneAt` when a turn looks like the end of it; the user alone
 * closes. The shape is owned by `packages/web/server/lib/session-work/state.js`.
 */
const workSchema = z.object({
  state: z.enum(['open', 'done']),
  openedAt: z.number().optional(),
  openedBy: z.enum(['jev', 'user']).optional(),
  doneAt: z.number().optional(),
  suggestDoneAt: z.number().optional(),
});

export type SessionWork = z.infer<typeof workSchema>;

const namespaceSchema = z.object({ openchamber: z.object({ work: workSchema }) });

export function getSessionWork(session: Session | null | undefined): SessionWork | null {
  return namespaceSchema.safeParse(session?.metadata).data?.openchamber.work ?? null;
}

const inWorkSchema = z.object({ openchamber: z.object({ work: z.object({ state: z.literal('open') }) }) });

/** Membership in the sidebar's "In work" block. */
export function isSessionInWork(session: Session | null | undefined): boolean {
  return inWorkSchema.safeParse(session?.metadata).success;
}

/**
 * Whether Jev's "looks done" hint is current. The server writes it after a
 * turn ended and deletes it when the next one starts; the `time.idle` check
 * retires a hint that outlived that (another process, a missed event), the
 * same rule the session assist uses. Callers still hide it while a turn runs.
 */
export function isDoneSuggested(session: Session | null | undefined): boolean {
  const work = getSessionWork(session);
  if (work?.state !== 'open' || work.suggestDoneAt === undefined || !session) return false;
  return work.suggestDoneAt >= (session.time?.idle ?? 0);
}

const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) });

/**
 * The metadata after the user tracked the session (`open`) or marked it done.
 * Done keeps when and by whom the work was opened and drops Jev's hint.
 */
export function withSessionWorkState(metadata: Metadata, state: SessionWork['state'], now: number): Metadata {
  const namespace = openchamberSchema.safeParse(metadata).data?.openchamber ?? {};
  const current = namespaceSchema.safeParse(metadata).data?.openchamber.work ?? null;
  if (current?.state === state) return metadata;
  if (state === 'open') {
    return { ...metadata, openchamber: { ...namespace, work: { state: 'open', openedAt: now, openedBy: 'user' } } };
  }
  const work: Metadata = { state: 'done', doneAt: now };
  if (current?.openedAt !== undefined) work.openedAt = current.openedAt;
  if (current?.openedBy !== undefined) work.openedBy = current.openedBy;
  return { ...metadata, openchamber: { ...namespace, work } };
}
