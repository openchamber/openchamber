import { toast } from 'sonner';
import { runtimeFetch } from '@/lib/runtime-fetch';

const SMALL_MODEL_TOAST_ID = 'small-model-unavailable';

const notifySmallModelUnavailable = (): void => {
  toast.error('Small Model unavailable', {
    id: SMALL_MODEL_TOAST_ID,
    description: 'Choose another model in Settings → Sessions → Small Model and try again.',
  });
};

/**
 * A cancelled or deadline-aborted request is the caller's decision, not an
 * availability problem: rethrow it without the "Small Model unavailable"
 * toast. `TimeoutError` is what `AbortSignal.timeout` deadlines surface in
 * browsers; engines without it raise a plain `AbortError` instead.
 */
const isCallerAbort = (error: Error): boolean => {
  return error.name === 'AbortError' || error.name === 'TimeoutError';
};

export async function requestSmallModel(
  init: RequestInit,
  options: { silentStatuses?: number[] } = {},
): Promise<Response> {
  try {
    const response = await runtimeFetch('/api/small-model/generate', init);
    if (!response.ok && !options.silentStatuses?.includes(response.status)) {
      notifySmallModelUnavailable();
    }
    return response;
  } catch (error) {
    // Every rejection this fetch can raise is an Error (fetch aborts surface
    // as DOMException, an Error subclass); only cancellations skip the toast.
    if (!(error instanceof Error) || !isCallerAbort(error)) {
      notifySmallModelUnavailable();
    }
    throw error;
  }
}
