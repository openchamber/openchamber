import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { usePluginsStore } from '@/stores/usePluginsStore';
import type { PluginRuntimeTarget } from './pluginLoadState';
import { usePluginPackageUpdate, usePluginRuntimeStatus } from './usePluginRuntimeStatus';

interface PluginStatusBannerProps {
  target: PluginRuntimeTarget | null;
  /** How the plugin is named in toasts. */
  name: string;
}

/** What OpenCode reports for the selected plugin, plus the update OpenCode can install for it. */
export const PluginStatusBanner: React.FC<PluginStatusBannerProps> = ({ target, name }) => {
  const { t } = useI18n();
  const status = usePluginRuntimeStatus(target);
  const packageUpdate = usePluginPackageUpdate(target);
  const loadRuntime = usePluginsStore((s) => s.loadRuntime);
  const updatePackage = usePluginsStore((s) => s.updatePackage);

  if (status.kind === 'loading') return null;

  if (status.kind === 'unknown') {
    return (
      <div className="rounded-md border border-border bg-card p-3 flex items-start gap-3">
        <Icon name="question" className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="typography-label text-foreground">{t('settings.plugins.status.unknown.title')}</p>
          <p className="typography-micro text-muted-foreground mt-0.5">
            {t('settings.plugins.status.unknown.description')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void loadRuntime()}>
          {t('settings.plugins.status.retry')}
        </Button>
      </div>
    );
  }

  const { load, update } = status;
  const packageTarget = status.target.kind === 'package' ? status.target.target : null;
  const isUpdating = update === 'updating' || packageUpdate?.kind === 'running';

  const handleUpdate = async () => {
    if (!packageTarget) return;
    const ok = await updatePackage(packageTarget);
    if (ok) toast.success(t('settings.plugins.update.toast.done', { name }));
    else toast.error(t('settings.plugins.update.toast.failed', { name }));
  };

  const loadBlock = (() => {
    switch (load.kind) {
      case 'active':
        return (
          <p className="typography-meta flex items-center gap-1.5 text-muted-foreground">
            <Icon name="checkbox-circle" className="h-4 w-4 text-[var(--status-success)]" />
            {load.version
              ? t('settings.plugins.status.loadedVersion', { version: load.version })
              : t('settings.plugins.status.loaded')}
          </p>
        );
      case 'notReported':
        return (
          <div className="rounded-md border border-border bg-card p-3 flex items-start gap-3">
            <Icon name="time" className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="typography-label text-foreground">{t('settings.plugins.status.notReported.title')}</p>
              <p className="typography-micro text-muted-foreground mt-0.5">
                {t('settings.plugins.status.notReported.description')}
              </p>
            </div>
          </div>
        );
      case 'failed':
        return (
          <div className="rounded-md border border-border bg-card p-3 flex items-start gap-3">
            <Icon name="error-warning" className="h-5 w-5 text-[var(--status-error)] shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="typography-label text-[var(--status-error)]">{t('settings.plugins.status.failed.title')}</p>
              <p className="typography-micro font-mono text-foreground mt-1 whitespace-pre-wrap break-words">
                {load.error}
              </p>
              {load.ref ? (
                <p className="typography-micro text-muted-foreground mt-1">
                  {t('settings.plugins.status.failed.ref', { ref: load.ref })}
                </p>
              ) : null}
            </div>
          </div>
        );
    }
  })();

  const showUpdate = packageTarget !== null && (update !== 'none' || packageUpdate !== null);

  return (
    <div className="flex flex-col gap-3">
      {loadBlock}
      {showUpdate ? (
        <div className="rounded-md border border-border bg-card p-3 flex items-start gap-3">
          <Icon name="arrow-up" className="h-5 w-5 text-[var(--status-success)] shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="typography-label text-[var(--status-success)]">
              {t('settings.plugins.update.available.title')}
            </p>
            <p className="typography-micro text-muted-foreground mt-0.5">
              {t('settings.plugins.update.available.description')}
            </p>
            {packageUpdate?.kind === 'failed' ? (
              <>
                <p className="typography-micro text-[var(--status-error)] mt-2">
                  {t('settings.plugins.update.failed.title')}
                </p>
                <p className="typography-micro font-mono text-foreground mt-0.5 whitespace-pre-wrap break-words">
                  {packageUpdate.error}
                </p>
              </>
            ) : null}
          </div>
          <Button variant="default" size="sm" onClick={() => void handleUpdate()} disabled={isUpdating}>
            {isUpdating ? (
              <>
                <Icon name="loader-4" className="size-4 animate-spin" />
                {t('settings.plugins.update.running')}
              </>
            ) : (
              t('settings.plugins.update.action')
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
