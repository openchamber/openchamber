import * as React from 'react';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';

const TOAST_ID = 'project-config-invalid';

/**
 * Keeps OpenCode's "this project's config is invalid" error on screen while
 * that project is active. The error lives in the config store per project, so
 * switching to a healthy project clears the toast and switching back shows it
 * again; a successful reload after the user fixes the file clears it too.
 */
export const ProjectConfigErrorToast: React.FC = () => {
  const { t } = useI18n();
  const activeDirectoryKey = useConfigStore((state) => state.activeDirectoryKey);
  const error = useConfigStore((state) => state.projectConfigErrors[activeDirectoryKey]);
  const [isRetrying, setIsRetrying] = React.useState(false);

  const retry = React.useCallback(() => {
    const store = useConfigStore.getState();
    const directory = store.activeDirectoryKey;
    setIsRetrying(true);
    void Promise.all([
      store.loadProviders({ directory, source: 'projectConfigError:retry' }),
      store.loadAgents({ directory, source: 'projectConfigError:retry' }),
    ]).finally(() => setIsRetrying(false));
  }, []);

  React.useEffect(() => {
    if (!error) {
      toast.dismiss(TOAST_ID);
      return;
    }
    toast.error(t('projectConfigError.toast.title'), {
      id: TOAST_ID,
      duration: Infinity,
      description: (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="break-all font-mono typography-meta">{error.path ?? t('projectConfigError.toast.unknownFile')}</span>
          {error.message && (
            <span className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono typography-meta">{error.message}</span>
          )}
          <span className="typography-meta text-muted-foreground">{t('projectConfigError.toast.hint')}</span>
        </div>
      ),
      action: {
        label: isRetrying ? t('projectConfigError.toast.retrying') : t('projectConfigError.toast.retry'),
        onClick: (event) => {
          // Keep the toast open: it closes by itself once the config loads.
          event.preventDefault();
          if (!isRetrying) retry();
        },
      },
    });
  }, [error, isRetrying, retry, t]);

  React.useEffect(() => () => { toast.dismiss(TOAST_ID); }, []);

  return null;
};
