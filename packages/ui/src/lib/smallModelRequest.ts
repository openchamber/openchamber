import { toast } from 'sonner';
import { z } from 'zod';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { openCodeTrustRefusalDirectory } from '@/lib/opencodeTrust';
import { runtimeFetch, type RuntimeFetchOptions } from '@/lib/runtime-fetch';
import { useUIStore } from '@/stores/useUIStore';

const SMALL_MODEL_TOAST_ID = 'small-model-unavailable';
const SMALL_MODEL_TRUST_TOAST_ID = 'small-model-trust-required';

const notifySmallModelUnavailable = (): void => {
  const dictionary = useI18nStore.getState().dictionary;
  toast.error(formatMessage(dictionary, 'smallModel.toast.unavailable.title'), {
    id: SMALL_MODEL_TOAST_ID,
    description: formatMessage(dictionary, 'smallModel.toast.unavailable.description'),
    action: {
      label: formatMessage(dictionary, 'smallModel.toast.unavailable.action'),
      onClick: () => useUIStore.getState().openSettingsAt('sessions', 'sessions.small-model'),
    },
  });
};

// A folder-trust refusal is not the model's fault: show the server's
// instructions for the folder instead of sending the user to model settings.
const refusalMessageSchema = z.object({ error: z.string().trim().min(1) });

const notifyFolderTrustRequired = async (response: Response, directory: string): Promise<void> => {
  const parsed = refusalMessageSchema.safeParse(await response.clone().json().catch(() => null));
  const message = parsed.success
    ? parsed.data.error
    : formatMessage(useI18nStore.getState().dictionary, 'chat.trustPaused.text', { name: directory });
  toast.error(message, { id: SMALL_MODEL_TRUST_TOAST_ID });
};

const notifyFailedResponse = async (response: Response): Promise<void> => {
  const trustDirectory = await openCodeTrustRefusalDirectory(response);
  if (trustDirectory) {
    await notifyFolderTrustRequired(response, trustDirectory);
    return;
  }
  notifySmallModelUnavailable();
};

/**
 * One request to OpenChamber's background model. Any failure that is not in
 * `silentStatuses` raises a shared toast: the folder-trust instructions when
 * the server refused an untrusted folder, otherwise "Small Model unavailable".
 * Callers with a graceful fallback (a note kept verbatim, a reply spoken in
 * full) silence the 404 that means "no model to run on". Callers that show
 * their own error toast use `notifyOnError: false` to avoid duplicate
 * notifications. The returned response's body is left unread.
 */
export async function requestSmallModel(
  init: RuntimeFetchOptions,
  options: { silentStatuses?: number[]; notifyOnError?: boolean } = {},
): Promise<Response> {
  try {
    const response = await runtimeFetch('/api/small-model/generate', init);
    if (options.notifyOnError !== false && !response.ok && !options.silentStatuses?.includes(response.status)) {
      await notifyFailedResponse(response);
    }
    return response;
  } catch (error) {
    if (options.notifyOnError !== false) notifySmallModelUnavailable();
    throw error;
  }
}
