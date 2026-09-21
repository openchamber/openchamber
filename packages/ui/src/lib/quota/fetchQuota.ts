import { z } from 'zod';
import type { ProviderResult, QuotaProviderId } from '@/types';
import { runtimeFetch } from '@/lib/runtime-fetch';

const windowSchema = z.object({
  usedPercent: z.number().nullable(),
  remainingPercent: z.number().nullable(),
  windowSeconds: z.number().nullable(),
  resetAfterSeconds: z.number().nullable(),
  resetAt: z.number().nullable(),
  resetAtFormatted: z.string().nullable(),
  resetAfterFormatted: z.string().nullable(),
  valueLabel: z.string().nullable().optional(),
});
const windowsSchema = z.record(z.string(), windowSchema);

/** The deadline covers response bodies too, including transports that ignore abort. */
export const fetchQuota = async (
  providerId: QuotaProviderId,
  { signal, timeoutMs = 30_000 }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ProviderResult> => {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('The operation was aborted.', 'AbortError'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Quota request timed out', 'TimeoutError')), timeoutMs);
  let rejectAborted: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectAborted();
    else controller.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  const readResult = async () => {
    controller.signal.throwIfAborted();
    const response = await runtimeFetch(`/api/quota/${encodeURIComponent(providerId)}`, { signal: controller.signal });
    const payload = await response.json();
    if (!response.ok) {
      const failure = z.object({ error: z.string() }).safeParse(payload);
      throw new Error(failure.success ? failure.data.error : `Failed to fetch quota (${response.status})`);
    }
    return z.object({
      providerId: z.literal(providerId),
      providerName: z.string(),
      ok: z.boolean(),
      configured: z.boolean(),
      error: z.string().optional(),
      planLabel: z.string().nullable().optional(),
      usage: z.object({ windows: windowsSchema, models: z.record(z.string(), z.object({ windows: windowsSchema })).optional() }).nullable(),
      fetchedAt: z.number(),
    }).parse(payload);
  };
  try {
    return await Promise.race([readResult(), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAborted);
  }
};
