import { toast } from '@/components/ui';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { isConnectedToSharedOpenCodeService, SHARED_SERVICE_RESTART_COMMAND } from '@/lib/sharedOpenCodeService';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';

type TranslateFn = (key: I18nKey, params?: I18nParams) => string;

export async function restartOpenCodeWithFeedback(t: TranslateFn): Promise<boolean> {
  const isCurrent = captureRuntimeInstance();
  try {
    const shared = await isConnectedToSharedOpenCodeService();
    if (!isCurrent()) return false;
    if (shared) {
      toast.warning(t('settings.openchamber.opencodeCli.restart.sharedServiceCommand'), {
        description: SHARED_SERVICE_RESTART_COMMAND,
      });
      return false;
    }
    await reloadOpenCodeConfiguration({
      message: t('settings.openchamber.opencodeCli.actions.restartingOpenCode'),
      scopes: ['all'],
    });
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    // SAFETY: reloadOpenCodeConfiguration tags the Error it raises with
    // `requiresManualRestart` when OpenCode runs outside OpenChamber.
    if ((error as Error & { requiresManualRestart?: boolean })?.requiresManualRestart) {
      toast.warning(t('settings.openchamber.opencodeCli.restart.external'));
      return false;
    }
    toast.error(t('settings.openchamber.opencodeCli.restart.restartFailed'));
    return false;
  }
}
