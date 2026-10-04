import { z } from 'zod';
import type { JsonValue } from './contract.ts';

import {
  GUEST_POPOVER_CLOSE_REASONS,
  GUEST_POPOVER_COORDINATE_MAX,
  GUEST_POPOVER_DATA_MAX,
  GUEST_POPOVER_DATA_DEPTH_MAX,
  GUEST_POPOVER_HEIGHT_MAX,
  GUEST_POPOVER_HEIGHT_MIN,
  GUEST_POPOVER_ID,
  GUEST_POPOVER_SIDES,
  GUEST_POPOVER_WIDTH_MAX,
  GUEST_POPOVER_WIDTH_MIN,
} from './popover.ts';

const jsonPrimitive = z.union([z.string().max(GUEST_POPOVER_DATA_MAX), z.number(), z.boolean(), z.null()]);
const jsonRecord = z.record(z.string().max(GUEST_POPOVER_DATA_MAX), z.unknown());

// Parse one level at a time: recursive z.json() would traverse a hostile cycle
// or deeply nested structured-clone payload before its size/depth refinement.
export const guestPopoverDataSchema = z.custom<JsonValue>((value) => {
  const pending = [{ value, depth: 0 }];
  let size = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const item = current.value;
    if (current.depth >= GUEST_POPOVER_DATA_DEPTH_MAX) return false;
    if (Array.isArray(item)) {
      if (item.length > GUEST_POPOVER_DATA_MAX) return false;
      if (Object.keys(item).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) return false;
      size += 2 + Math.max(0, item.length - 1);
      for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
    } else {
      const primitive = jsonPrimitive.safeParse(item);
      if (primitive.success) {
        size += JSON.stringify(primitive.data).length;
      } else {
        const record = jsonRecord.safeParse(item);
        if (!record.success) return false;
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== null && prototype !== Object.prototype) return false;
        // z.record normalizes prototype-named keys. Validate the original
        // structured-clone values so those keys cannot escape the budget.
        const entries = Object.entries(Object.getOwnPropertyDescriptors(item)).filter(([, descriptor]) => descriptor.enumerable);
        size += 2 + Math.max(0, entries.length - 1);
        for (const [key, descriptor] of entries) {
          if (!('value' in descriptor)) return false;
          size += JSON.stringify(key).length + 1;
          if (size > GUEST_POPOVER_DATA_MAX) return false;
          pending.push({ value: descriptor.value, depth: current.depth + 1 });
        }
      }
    }
    if (size > GUEST_POPOVER_DATA_MAX) return false;
  }
  return true;
}, 'Popover data must be finite JSON within its size and depth limits.');

export const guestPopoverRequestSchema = z.object({
  id: z.string().regex(GUEST_POPOVER_ID),
  anchor: z.object({
    x: z.number().finite().min(-GUEST_POPOVER_COORDINATE_MAX).max(GUEST_POPOVER_COORDINATE_MAX),
    y: z.number().finite().min(-GUEST_POPOVER_COORDINATE_MAX).max(GUEST_POPOVER_COORDINATE_MAX),
    width: z.number().finite().positive().max(GUEST_POPOVER_COORDINATE_MAX),
    height: z.number().finite().positive().max(GUEST_POPOVER_COORDINATE_MAX),
  }).strict(),
  width: z.number().int().min(GUEST_POPOVER_WIDTH_MIN).max(GUEST_POPOVER_WIDTH_MAX),
  height: z.number().int().min(GUEST_POPOVER_HEIGHT_MIN).max(GUEST_POPOVER_HEIGHT_MAX),
  side: z.enum(GUEST_POPOVER_SIDES).optional(),
  focus: z.boolean().optional(),
  data: guestPopoverDataSchema,
}).strict();

export const guestPopoverClosedEventSchema = z.object({
  id: z.string().regex(GUEST_POPOVER_ID),
  reason: z.enum(GUEST_POPOVER_CLOSE_REASONS),
}).strict();
