import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

export const browserDebugPortSchema = z.number().int().min(0).max(65535);
const activePortSchema = browserDebugPortSchema.min(1);
const browserRuntimeStatusSchema = z.discriminatedUnion('running', [
  z.object({
    configuredPort: browserDebugPortSchema,
    running: z.literal(true),
    activePort: activePortSchema,
    restartRequired: z.boolean(),
  }),
  z.object({
    configuredPort: browserDebugPortSchema,
    running: z.literal(false),
    activePort: z.null(),
    restartRequired: z.boolean(),
  }),
]);

export type BrowserRuntimeStatus = z.infer<typeof browserRuntimeStatusSchema>;

export const parseBrowserDebugPortInput = (input: string): number | null => {
  if (!/^\d+$/.test(input.trim())) return null;
  const parsed = activePortSchema.safeParse(Number(input.trim()));
  return parsed.success ? parsed.data : null;
};

class BrowserRuntimeStatusError extends Error {
  constructor(readonly status: number) {
    super('Browser runtime status request failed');
  }
}

export const readBrowserRuntimeStatus = async (signal: AbortSignal): Promise<BrowserRuntimeStatus> => {
  const response = await runtimeFetch('/api/browser/runtime-status', { signal, cache: 'no-store' });
  if (!response.ok) throw new BrowserRuntimeStatusError(response.status);
  return browserRuntimeStatusSchema.parse(await response.json());
};
