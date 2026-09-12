import { z } from 'zod';

export const DEVTOOLS_CHUNK_BYTES = 32 * 1024;
export const DEVTOOLS_COMMAND_BYTES = 16 * 1024 * 1024;
export const DEVTOOLS_MESSAGE_BYTES = 64 * 1024 * 1024;
export const DEVTOOLS_TIMEOUT_MS = 15_000;

const identity = z.string().min(1).max(128);
const requestIdentity = z.object({ tabId: identity, requestId: identity, attachmentRequestId: identity });
const errorCode = z.enum([
  'DEVTOOLS_INVALID_REQUEST', 'DEVTOOLS_START_FAILED', 'DEVTOOLS_PROTOCOL_REJECTED',
  'DEVTOOLS_CONTROL_LOST', 'DEVTOOLS_CONNECTION_CLOSED', 'DEVTOOLS_MESSAGE_TOO_LARGE',
  'DEVTOOLS_BACKPRESSURE', 'DEVTOOLS_EXCLUSIVE_CONTEXT_REQUIRED',
]);

const chunk = z.object({
  devtoolsId: identity, messageId: identity,
  index: z.number().int().min(0).max(2047), count: z.number().int().min(1).max(2048),
  byteLength: z.number().int().min(1).max(DEVTOOLS_MESSAGE_BYTES),
  data: z.string().min(1).max(4 * Math.ceil(DEVTOOLS_CHUNK_BYTES / 3)),
});

const chunkAck = z.object({
  type: z.literal('devtoolsChunkAck'), devtoolsId: identity, messageId: identity,
  direction: z.enum(['command', 'message']), index: z.number().int().min(0).max(2047),
}).readonly();

export const surfaceDevToolsMessageSchema = z.discriminatedUnion('type', [
  requestIdentity.extend({
    type: z.literal('devtoolsStarted'), devtoolsId: identity,
    frontendPath: z.string().regex(/^\/api\/browser-devtools\/[A-Za-z0-9_-]{32}\/inspector\.html$/),
  }).readonly(),
  requestIdentity.extend({
    type: z.literal('devtoolsError'), code: errorCode, message: z.string().max(512),
  }).readonly(),
  chunk.extend({ type: z.literal('devtoolsMessageChunk') }).readonly(),
  chunkAck,
  z.object({ type: z.literal('devtoolsStopped'), devtoolsId: identity }).readonly(),
  z.object({
    type: z.literal('devtoolsClosed'), devtoolsId: identity, code: errorCode,
    message: z.string().max(512),
  }).readonly(),
]);

export type DevToolsAttachment = { readonly tabId: string; readonly attachmentRequestId: string };
export type DevToolsErrorCode = z.infer<typeof errorCode>;
export type DevToolsChunk = z.infer<typeof chunk>;
export type DevToolsChunkAck = z.infer<typeof chunkAck>;
export type DevToolsCommand =
  | (DevToolsAttachment & { readonly type: 'devtoolsStart'; readonly requestId: string })
  | (DevToolsChunk & { readonly type: 'devtoolsCommandChunk' })
  | DevToolsChunkAck
  | { readonly type: 'devtoolsStop'; readonly devtoolsId?: string };
