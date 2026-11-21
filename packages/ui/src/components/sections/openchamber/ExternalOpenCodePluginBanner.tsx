import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useExternalOpenCodePlugin } from '@/hooks/useExternalOpenCodePlugin';

export const ExternalOpenCodePluginBanner: React.FC<{ refreshKey?: number }> = ({ refreshKey = 0 }) => {
  const { t } = useI18n();
  const {
    status,
    busy,
    justAddedPath,
    copyPath,
    addToGlobalConfig,
    removeFromGlobalConfig,
  } = useExternalOpenCodePlugin(refreshKey);

  if (!status || status.delivery === 'file' || status.delivery === 'restart') {
    return null;
  }

  if (status.delivery === 'remote') {
    return (
      <p className="max-w-[44rem] rounded-lg bg-[var(--status-info)]/10 p-3 typography-meta text-[var(--status-info)]">
        {t('settings.openchamber.externalPlugin.remote')}
      </p>
    );
  }

  const registeredPath = justAddedPath ?? (status.inGlobalConfig ? status.globalConfigPath : null);

  return (
    <div className="max-w-[44rem] space-y-2 rounded-lg bg-[var(--status-info)]/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="typography-meta min-w-0 flex-1 basis-64 text-[var(--status-info)]">
          {justAddedPath
            ? t('settings.openchamber.externalPlugin.added', { path: justAddedPath })
            : registeredPath
              ? t('settings.openchamber.externalPlugin.inGlobal', { path: registeredPath })
              : t('settings.openchamber.externalPlugin.notice')}
        </span>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {registeredPath ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void removeFromGlobalConfig()}
            >
              {t('settings.openchamber.externalPlugin.remove')}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void addToGlobalConfig()}
            >
              {t('settings.openchamber.externalPlugin.add')}
            </Button>
          )}
        </div>
      </div>
      {status.pluginPath ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded bg-background/60 px-2 py-1 font-mono text-xs text-foreground">
            {status.pluginPath}
          </code>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => void copyPath()}
          >
            <Icon name="file-copy" className="me-1 size-3.5" />
            {t('settings.openchamber.externalPlugin.copyPath')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
