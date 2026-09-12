import { z } from 'zod';

const identity = z.string().min(1).max(128);
const timestamp = z.number().finite().nonnegative().max(8.64e15);
const scope = z.enum(['console', 'network']);
const errorCode = z.enum(['UNAVAILABLE', 'INVALID_REQUEST', 'CAPTURE_GONE', 'EVALUATION_FAILED',
  'EVALUATION_TIMEOUT', 'REQUEST_GONE', 'REQUEST_FAILED', 'CAPTURE_FAILED']);
const header = z.object({ name: z.string().max(256), value: z.string().max(1024) }).readonly();
const requestIdentity = z.object({ tabId: identity, requestId: identity });
const captureIdentity = requestIdentity.extend({ captureId: identity });

const consoleEntry = z.object({
  id: identity, timestamp, level: z.enum(['debug', 'info', 'log', 'warning', 'error']),
  text: z.string().max(4000), source: z.string().max(2048),
  line: z.number().int().nonnegative().nullable(), truncated: z.boolean(),
}).readonly();

const networkEntry = z.object({
  id: identity, timestamp, method: z.string().max(128), url: z.string().max(2048),
  resourceType: z.string().max(128), status: z.number().int().nonnegative().nullable(),
  statusText: z.string().max(128), mimeType: z.string().max(128),
  durationMs: z.number().finite().nonnegative().nullable(),
  encodedBytes: z.number().finite().nonnegative().nullable(),
  state: z.enum(['pending', 'complete', 'failed']), failureText: z.string().max(1024).nullable(),
  fromCache: z.boolean(),
}).readonly();

const evaluation = captureIdentity.extend({
  type: z.literal('inspectorEvaluated'), text: z.string().max(8000),
  isError: z.boolean(), truncated: z.boolean(),
}).readonly();

const requestDetails = captureIdentity.extend({
  type: z.literal('inspectorRequestResult'), entryId: identity,
  requestHeaders: z.array(header).max(64), responseHeaders: z.array(header).max(64),
  requestBody: z.string().max(8000).nullable(), responseBody: z.string().max(8000).nullable(),
  bodyState: z.enum(['not-requested', 'available', 'unavailable', 'unsupported']),
  truncated: z.boolean(),
}).readonly();

export const surfaceInspectorMessageSchema = z.discriminatedUnion('type', [
  captureIdentity.extend({ type: z.literal('inspectorStarted') }).readonly(),
  z.object({
    type: z.literal('inspectorEvents'), tabId: identity, captureId: identity,
    console: z.array(consoleEntry).max(32), network: z.array(networkEntry).max(32),
    droppedConsole: z.number().int().nonnegative(), droppedNetwork: z.number().int().nonnegative(),
  }).readonly(),
  captureIdentity.extend({ type: z.literal('inspectorCleared'), scope }).readonly(),
  evaluation,
  requestDetails,
  requestIdentity.extend({
    type: z.literal('inspectorError'), captureId: identity.optional(), code: errorCode,
    message: z.string().max(512),
  }).readonly(),
]);

export type SurfaceConsoleEntry = z.infer<typeof consoleEntry>;
export type SurfaceNetworkEntry = z.infer<typeof networkEntry>;
export type SurfaceInspectorEvaluation = z.infer<typeof evaluation>;
export type SurfaceInspectorRequestDetails = z.infer<typeof requestDetails>;
export type SurfaceInspectorErrorCode = z.infer<typeof errorCode> | 'CANCELLED' | 'TIMEOUT';
export type SurfaceInspectorScope = z.infer<typeof scope>;

type RequestIdentity = Readonly<z.infer<typeof requestIdentity>>;
type CaptureIdentity = Readonly<z.infer<typeof captureIdentity>>;
export type SurfaceInspectorCommand =
  | (RequestIdentity & { readonly type: 'inspectorStart' })
  | (RequestIdentity & { readonly type: 'inspectorStop'; readonly captureId?: string })
  | (CaptureIdentity & { readonly type: 'inspectorClear'; readonly scope: SurfaceInspectorScope })
  | (CaptureIdentity & { readonly type: 'inspectorEvaluate'; readonly expression: string })
  | (CaptureIdentity & { readonly type: 'inspectorRequest'; readonly entryId: string; readonly includeBody: boolean });
