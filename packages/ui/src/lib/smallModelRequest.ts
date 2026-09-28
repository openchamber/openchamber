import { toast } from 'sonner';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

const SMALL_MODEL_TOAST_ID = 'small-model-unavailable';

const notifySmallModelUnavailable = (): void => {
  const dictionary = useI18nStore.getState().dictionary;
  toast.error(formatMessage(dictionary, 'smallModel.toast.unavailable.title'), {
    id: SMALL_MODEL_TOAST_ID,
    description: formatMessage(dictionary, 'smallModel.toast.unavailable.description'),
  });
};

/**
 * One request to OpenChamber's background model. Any failure that is not in
 * `silentStatuses` raises the shared "Small Model unavailable" toast; callers
 * with a graceful fallback (a note kept verbatim, a reply spoken in full)
 * silence the 404 that means "no model to run on". Callers that show their own
 * error toast use `notifyOnError: false` to avoid duplicate notifications.
 */
export async function requestSmallModel(
  init: RequestInit,
  options: { silentStatuses?: number[]; notifyOnError?: boolean } = {},
): Promise<Response> {
  try {
    const response = await runtimeFetch('/api/small-model/generate', init);
    if (options.notifyOnError !== false && !response.ok && !options.silentStatuses?.includes(response.status)) {
      notifySmallModelUnavailable();
    }
    return response;
  } catch (error) {
    if (options.notifyOnError !== false) notifySmallModelUnavailable();
    throw error;
  }
}
