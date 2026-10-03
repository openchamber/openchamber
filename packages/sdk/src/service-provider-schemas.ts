import { z } from 'zod';

import { BROWSER_CONTROL_ACTIONS } from './service-providers.ts';

/**
 * Host-side parse of what a browser provider answers. `data` stays whatever
 * the service produced: the host hands it to the agent as is, and only
 * `browser.capture` is read further (the image the host writes to disk).
 */
export const browserProviderResultSchema = z.union([
  z.object({ ok: z.literal(true), data: z.object({}).passthrough() }),
  z.object({ ok: z.literal(false), error: z.string().min(1).max(2_000) }),
]);

export const browserControlActionSchema = z.enum(BROWSER_CONTROL_ACTIONS);
