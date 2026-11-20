import { z } from 'zod';
import { hasMessage } from './contracts.js';
import type { TranslatedEvent } from '../event-stream/translate-v2.js';

const sessionEventSchema = z.object({
  type: z.string(),
  created: z.number().finite(),
  properties: z.object({ sessionID: z.string().min(1) }).loose(),
});

const statusSchema = z.object({ type: z.string() }).loose();

interface TurnDurationDependencies<Result> {
  persistSessionMetadataPatch: (sessionID: string, patch: { openchamber: { turn: { endedAt: number; durationMs: number } } }, options: { directory: string }) => Promise<Result>;
  isChildSession: (sessionID: string) => boolean | undefined;
}

const hasEventType = (value: unknown): value is { type: unknown } =>
  value !== null && value !== undefined && 'type' in Object(value);

export const createTurnDurationRecorder = <Result>({ persistSessionMetadataPatch, isChildSession }: TurnDurationDependencies<Result>) => {
  const startedAt = new Map<string, number>();

  const record = (sessionID: string, start: number, endedAt: number, directory: string) => {
    if (isChildSession(sessionID) === true) return;
    const turn = { endedAt, durationMs: Math.max(0, endedAt - start) };
    void Promise.resolve(persistSessionMetadataPatch(sessionID, { openchamber: { turn } }, { directory }))
      .catch((cause: unknown) => console.warn('[turn-duration] could not record a turn length:', (hasMessage(cause) ? cause.message : undefined) ?? cause));
  };

  const processPayload = (payload: TranslatedEvent | undefined, directory = '') => {
    if (hasEventType(payload) && payload.type === 'server.connected') {
      startedAt.clear();
      return;
    }
    const parsed = sessionEventSchema.safeParse(payload);
    if (!parsed.success) return;
    const { type, created, properties } = parsed.data;
    const { sessionID } = properties;

    if (type === 'session.status') {
      const status = statusSchema.safeParse(properties.status);
      if (status.success && (status.data.type === 'busy' || status.data.type === 'retry') && !startedAt.has(sessionID)) {
        startedAt.set(sessionID, created);
      }
      return;
    }
    if (type === 'session.deleted') {
      startedAt.delete(sessionID);
      return;
    }
    if (type !== 'session.idle' && type !== 'session.error') return;
    const start = startedAt.get(sessionID);
    startedAt.delete(sessionID);
    if (start !== undefined) record(sessionID, start, created, directory);
  };

  return { processPayload };
};
