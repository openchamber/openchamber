import { z } from 'zod';
import type { GuestItem } from './contract.ts';
import { PROJECT_KNOWLEDGE_TABS } from './navigation.ts';

export const guestOpenSurfacePayloadSchema = (item: z.ZodType<GuestItem>) => z.object({
  surfaceId: z.string().trim().min(1),
  options: z.union([
    z.strictObject({ tab: z.enum(PROJECT_KNOWLEDGE_TABS), item: z.never().optional() }),
    z.strictObject({ item, tab: z.never().optional() }),
  ]).nullable().catch(null).optional(),
});
