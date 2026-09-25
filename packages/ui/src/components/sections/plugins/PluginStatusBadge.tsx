import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import type { PluginRuntimeTarget } from './pluginLoadState';
import { usePluginPackageUpdate, usePluginRuntimeStatus } from './usePluginRuntimeStatus';

/**
 * The sidebar row's runtime marker. A loaded plugin stays quiet; an unknown
 * status is announced once in the sidebar header rather than on every row.
 */
export const PluginStatusBadge: React.FC<{ target: PluginRuntimeTarget | null }> = ({ target }) => {
  const { t } = useI18n();
  const status = usePluginRuntimeStatus(target);
  const packageUpdate = usePluginPackageUpdate(target);

  if (status.kind !== 'known') return null;

  const marker = (() => {
    if (status.update === 'updating' || packageUpdate?.kind === 'running') {
      return { icon: <Icon name="loader-4" className="h-3 w-3 animate-spin text-muted-foreground" />, label: t('settings.plugins.update.running') };
    }
    if (status.load.kind === 'failed') {
      return { icon: <Icon name="error-warning" className="h-3 w-3 text-[var(--status-error)]" />, label: t('settings.plugins.status.failed.title') };
    }
    if (status.load.kind === 'notReported') {
      return { icon: <Icon name="time" className="h-3 w-3 text-muted-foreground" />, label: t('settings.plugins.status.notReported.title') };
    }
    if (status.update === 'available') {
      return { icon: <Icon name="arrow-up-s" className="h-3 w-3 text-[var(--status-success)]" />, label: t('settings.plugins.update.available.title') };
    }
    return null;
  })();

  if (!marker) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center" aria-label={marker.label}>
          {marker.icon}
        </span>
      </TooltipTrigger>
      <TooltipContent>{marker.label}</TooltipContent>
    </Tooltip>
  );
};
