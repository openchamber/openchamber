import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';

const turnMetadataSchema = z.object({
  openchamber: z.object({
    turn: z.object({
      endedAt: z.number().finite(),
      durationMs: z.number().finite().nonnegative(),
    }),
  }),
});

const SAME_TURN_TOLERANCE_MS = 1_000;

const durationByRecord = new WeakMap<Session, { durationMs: number | undefined }>();

const readRecordedTurnDurationMs = (session: Session): number | undefined => {
  const idle = session.time.idle;
  if (idle === undefined) return undefined;
  const parsed = turnMetadataSchema.safeParse(session.metadata);
  if (!parsed.success) return undefined;
  const { endedAt, durationMs } = parsed.data.openchamber.turn;
  return Math.abs(idle - endedAt) <= SAME_TURN_TOLERANCE_MS ? durationMs : undefined;
};

export function getRecordedTurnDurationMs(session: Session | undefined): number | undefined {
  if (!session) return undefined;
  const cached = durationByRecord.get(session);
  if (cached) return cached.durationMs;
  const durationMs = readRecordedTurnDurationMs(session);
  durationByRecord.set(session, { durationMs });
  return durationMs;
}
