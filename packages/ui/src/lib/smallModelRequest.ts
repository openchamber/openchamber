import { toast } from 'sonner';
import { runtimeFetch } from '@/lib/runtime-fetch';

const SMALL_MODEL_TOAST_ID = 'small-model-unavailable';

const notifySmallModelUnavailable = (): void => {
  toast.error('Small Model unavailable', {
    id: SMALL_MODEL_TOAST_ID,
    description: 'Choose another model in Settings → Sessions → Small Model and try again.',
  });
};

export async function requestSmallModel(
  init: RequestInit,
  options: { silent?: boolean; silentStatuses?: number[] } = {},
): Promise<Response> {
  try {
    const response = await runtimeFetch('/api/small-model/generate', init);
    if (!response.ok && !options.silent && !options.silentStatuses?.includes(response.status)) {
      notifySmallModelUnavailable();
    }
    return response;
  } catch (error) {
    if (!options.silent) {
      notifySmallModelUnavailable();
    }
    throw error;
  }
}
