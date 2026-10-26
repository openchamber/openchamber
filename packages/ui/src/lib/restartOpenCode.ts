import { toast } from '@/components/ui';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';

type TranslateFn = (key: I18nKey, params?: I18nParams) => string;

// Manual restart for changes OpenCode cannot hot-apply (plugin presets, plugin
// config). An external OpenCode is not ours to restart; the server says so and
// the user is told to restart it where they started it.
export async function restartOpenCodeWithFeedback(t: TranslateFn): Promise<void> {
  try {
    await reloadOpenCodeConfiguration({
      message: t('settings.openchamber.opencodeCli.actions.restartingOpenCode'),
      mode: 'projects',
      scopes: ['all'],
    });
  } catch (error) {
    // SAFETY: reloadOpenCodeConfiguration tags the Error it raises with
    // `requiresManualRestart` when OpenCode runs outside OpenChamber.
    if ((error as Error & { requiresManualRestart?: boolean })?.requiresManualRestart) {
      toast.warning(t('settings.openchamber.opencodeCli.restart.external'));
      return;
    }
    toast.error(t('settings.openchamber.opencodeCli.restart.restartFailed'));
  }
}
