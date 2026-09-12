import { z } from 'zod';

const surfaceIdentitySchema = z.string().min(1).max(128);
const configuredDimensionSchema = z.number().int().min(1).max(3_840);
const observedDimensionSchema = z.number().finite().positive();

const viewportModeSchema = z.enum(['auto', 'fixed', 'external']);
const viewportSourceSchema = z.enum(['viewer', 'agent', 'external']);
const observedViewportSchema = z.object({
  layoutWidth: observedDimensionSchema,
  layoutHeight: observedDimensionSchema,
  visualWidth: observedDimensionSchema,
  visualHeight: observedDimensionSchema,
  visualScale: observedDimensionSchema,
});

const viewportSnapshotFields = {
  revision: z.number().int().min(0),
  mode: viewportModeSchema,
  observed: observedViewportSchema,
  autoAllowed: z.boolean(),
} as const;

const managedViewportSnapshotSchema = z.object({
  ...viewportSnapshotFields,
  width: configuredDimensionSchema,
  height: configuredDimensionSchema,
  source: viewportSourceSchema.exclude(['external']),
  mobile: z.boolean(),
  deviceScaleFactor: z.literal(1),
});

const externalViewportSnapshotSchema = z.object({
  ...viewportSnapshotFields,
  width: observedDimensionSchema,
  height: observedDimensionSchema,
  source: z.literal('external'),
  mobile: z.boolean().nullable(),
  deviceScaleFactor: z.number().finite().positive().nullable(),
});

const surfaceViewportSnapshotSchema = z.union([
  managedViewportSnapshotSchema,
  externalViewportSnapshotSchema,
]);

export type RemoteSurfaceViewportCommand = {
  readonly type: 'viewportSet';
  readonly requestId: string;
  readonly tabId: string;
  readonly attachmentRequestId: string;
  readonly width: number;
  readonly height: number;
  readonly mode: 'auto' | 'fixed';
  readonly mobile: boolean;
  readonly takeover: boolean;
};

const surfaceViewportResultSchema = z.object({
  type: z.literal('viewportResult'),
  requestId: surfaceIdentitySchema,
  tabId: surfaceIdentitySchema,
  attachmentRequestId: surfaceIdentitySchema,
  status: z.enum(['applied', 'unchanged', 'not-owner']),
  viewport: surfaceViewportSnapshotSchema,
});

const surfaceViewportStateSchema = z.object({
  type: z.literal('viewportState'),
  tabId: surfaceIdentitySchema,
  attachmentRequestId: surfaceIdentitySchema,
  viewport: surfaceViewportSnapshotSchema,
});

const SURFACE_VIEWPORT_ERROR_CODES = [
  'UNAVAILABLE',
  'INVALID_REQUEST',
  'STALE_ATTACHMENT',
  'SUPERSEDED',
  'RESIZE_FAILED',
  'RESIZE_TIMEOUT',
] as const;

const surfaceViewportErrorSchema = z.object({
  type: z.literal('viewportError'),
  requestId: surfaceIdentitySchema,
  tabId: surfaceIdentitySchema,
  attachmentRequestId: surfaceIdentitySchema,
  code: z.enum(SURFACE_VIEWPORT_ERROR_CODES),
  message: z.string().max(4_096),
});

export const surfaceViewportMessageSchema = z.union([
  surfaceViewportResultSchema,
  surfaceViewportStateSchema,
  surfaceViewportErrorSchema,
]);

export type RemoteSurfaceViewportSnapshot = z.infer<typeof surfaceViewportSnapshotSchema>;
export type RemoteSurfaceViewportMessage = z.infer<typeof surfaceViewportMessageSchema>;
export type RemoteSurfaceViewportErrorCode = z.infer<typeof surfaceViewportErrorSchema>['code'];
