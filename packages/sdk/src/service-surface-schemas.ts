import { z } from 'zod';

import {
  SURFACE_CONTROLLERS,
  SURFACE_DIMENSION_MAX,
  SURFACE_FRAME_MIMES,
  SURFACE_INPUT_BATCH_MAX,
  SURFACE_TEXT_MAX,
  SURFACE_TITLE_MAX,
} from './service-surface.ts';

const modifiersSchema = z.object({ alt: z.boolean(), ctrl: z.boolean(), meta: z.boolean(), shift: z.boolean() });

const finite = z.number().finite();

export const surfaceInputEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pointer'),
    action: z.enum(['down', 'up', 'move']),
    x: finite,
    y: finite,
    button: z.number().int().min(-1).max(4),
    buttons: z.number().int().min(0).max(31),
    modifiers: modifiersSchema,
  }),
  z.object({ type: z.literal('wheel'), x: finite, y: finite, deltaX: finite, deltaY: finite, modifiers: modifiersSchema }),
  z.object({
    type: z.literal('key'),
    action: z.enum(['down', 'up']),
    key: z.string().min(1).max(64),
    code: z.string().max(64),
    modifiers: modifiersSchema,
  }),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(SURFACE_TEXT_MAX) }),
]);

const dimension = z.number().int().min(1).max(SURFACE_DIMENSION_MAX);

/** What a viewer (the host panel) sends the host over the surface socket. */
export const surfaceViewerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ack'), seq: z.number().int().min(0) }),
  z.object({ type: z.literal('input'), events: z.array(surfaceInputEventSchema).min(1).max(SURFACE_INPUT_BATCH_MAX) }),
  z.object({ type: z.literal('release') }),
  z.object({ type: z.literal('resize'), width: dimension, height: dimension }),
  z.object({ type: z.literal('clipboard-read'), id: z.string().min(1).max(64) }),
]);
export type SurfaceViewerMessage = z.infer<typeof surfaceViewerMessageSchema>;

export const surfaceControllerSchema = z.enum(SURFACE_CONTROLLERS);

/**
 * What the host sends a viewer. A `frame` text message is followed by one
 * binary message carrying exactly `bytes` bytes of the image.
 */
export const surfaceHostMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), viewerId: z.string().min(1) }),
  z.object({
    type: z.literal('frame'),
    seq: z.number().int().min(0),
    width: dimension,
    height: dimension,
    mime: z.enum(SURFACE_FRAME_MIMES),
    bytes: z.number().int().min(1),
    title: z.string().max(SURFACE_TITLE_MAX).optional(),
    agentActive: z.boolean(),
  }),
  z.object({ type: z.literal('control'), controller: surfaceControllerSchema, mine: z.boolean() }),
  z.object({ type: z.literal('resized'), width: dimension, height: dimension }),
  z.object({ type: z.literal('clipboard'), id: z.string().min(1).max(64), text: z.string().max(SURFACE_TEXT_MAX) }),
  z.object({ type: z.literal('error'), code: z.string().min(1).max(64), message: z.string().min(1).max(500) }),
  z.object({ type: z.literal('ended'), reason: z.enum(['service-stopped', 'extension-unavailable', 'host-shutdown']) }),
]);
export type SurfaceHostMessage = z.infer<typeof surfaceHostMessageSchema>;

/** Service answers the host parses. */
export const surfaceResizeAnswerSchema = z.object({ width: dimension, height: dimension });
export const surfaceClipboardAnswerSchema = z.object({ text: z.string().max(SURFACE_TEXT_MAX) });
