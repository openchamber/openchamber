import { z } from 'zod';

const sessionTarget = { requestId: z.string(), sessionId: z.string() };

export const workerRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tts.synthesize'),
    requestId: z.string(),
    modelsDir: z.string(),
    modelId: z.string(),
    text: z.string(),
    speakerId: z.unknown().optional(),
    speed: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('session.create'),
    ...sessionTarget,
    modelsDir: z.string(),
    modelId: z.string(),
    language: z.string().optional().catch(undefined),
  }),
  z.object({ type: z.literal('session.append'), ...sessionTarget, audio: z.unknown() }),
  z.object({ type: z.literal('session.commit'), ...sessionTarget }),
  z.object({ type: z.literal('session.clear'), ...sessionTarget }),
  z.object({ type: z.literal('session.close'), ...sessionTarget }),
]);

export type WorkerRequest = z.infer<typeof workerRequestSchema>;

export const WORKER_REQUEST_TYPES = ['tts.synthesize', 'session.create', 'session.append', 'session.commit', 'session.clear', 'session.close'] as const;

export const requestHeadSchema = z.object({ type: z.unknown().optional(), requestId: z.unknown().optional() }).catch({});

export const committedPayloadSchema = z.object({ segmentId: z.string(), previousSegmentId: z.string().nullable() });
export const transcriptPayloadSchema = z.object({ segmentId: z.string(), transcript: z.string(), isFinal: z.boolean() });

export type CommittedPayload = z.infer<typeof committedPayloadSchema>;
export type TranscriptPayload = z.infer<typeof transcriptPayloadSchema>;

export type WorkerResult = { audio: Buffer; format: string } | { requiredSampleRate: number };

export const workerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('response'),
    requestId: z.string(),
    ok: z.boolean().optional(),
    result: z.unknown().optional(),
    error: z.string().optional().catch(undefined),
  }),
  z.object({ type: z.literal('session.committed'), sessionId: z.string(), payload: z.unknown() }),
  z.object({ type: z.literal('session.transcript'), sessionId: z.string(), payload: z.unknown() }),
  z.object({ type: z.literal('session.error'), sessionId: z.string(), error: z.string().optional().catch(undefined) }),
]);

export type WorkerMessage = z.infer<typeof workerMessageSchema>;

export const responseHeadSchema = z.object({ requestId: z.string().optional().catch(undefined) }).catch({});

export const synthesizeResultSchema = z.object({
  audio: z.instanceof(Uint8Array),
  format: z.string().optional().catch(undefined),
});

export const createSessionResultSchema = z.object({
  requiredSampleRate: z.number().positive().optional().catch(undefined),
}).optional().catch(undefined);
