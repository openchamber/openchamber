import React from 'react';
import { Icon } from '@/components/icon/Icon';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { usePluginsStore } from '@/stores/usePluginsStore';

interface RegistryBadgeProps {
  spec: string;
}

export const RegistryBadge: React.FC<RegistryBadgeProps> = ({ spec }) => {
  const info = usePluginsStore((s) => s.registryInfo[spec]);
  const { t } = useI18n();

  if (!info) return null;

  const wrap = (
    trigger: React.ReactNode,
    tooltipText: string,
  ): React.ReactElement => (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-0.5 text-xs">
          {trigger}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );

  switch (info.kind) {
    case 'npm-ok': {
      if (!info.hasUpdate || !info.latestVersion) return null;
      return wrap(
        <span className="inline-flex items-center gap-0.5 text-[var(--status-success)]">
          <Icon name="arrow-up-s" className="h-3 w-3" />
          {info.latestVersion}
        </span>,
        t('settings.plugins.registry.badge.update.tooltip', {
          current: info.currentVersion ?? '',
          latest: info.latestVersion,
        }),
      );
    }
    case 'npm-missing-version':
      return wrap(
        <Icon
          name="error-warning"
          className="h-3 w-3 text-[var(--status-warning)]"
        />,
        t('settings.plugins.registry.badge.missingVersion.tooltip', {
          version: info.currentVersion,
          name: info.name,
        }),
      );
    case 'npm-missing-package':
      return wrap(
        <Icon
          name="error-warning"
          className="h-3 w-3 text-[var(--status-error)]"
        />,
        t('settings.plugins.registry.badge.missingPackage.tooltip', {
          name: info.name,
        }),
      );
    case 'npm-malformed':
      return wrap(
        <Icon
          name="error-warning"
          className="h-3 w-3 text-[var(--status-error)]"
        />,
        t('settings.plugins.registry.badge.malformed.tooltip'),
      );
    case 'npm-network':
      return wrap(
        <Icon name="cloud-off" className="h-3 w-3 text-muted-foreground" />,
        t('settings.plugins.registry.badge.network.tooltip'),
      );
    case 'path-missing':
      return wrap(
        <Icon
          name="error-warning"
          className="h-3 w-3 text-[var(--status-error)]"
        />,
        t('settings.plugins.registry.badge.pathMissing.tooltip', {
          path: info.absolutePath,
        }),
      );
    case 'path-unreadable':
      return wrap(
        <Icon
          name="error-warning"
          className="h-3 w-3 text-[var(--status-warning)]"
        />,
        t('settings.plugins.registry.badge.pathUnreadable.tooltip', {
          path: info.absolutePath,
        }),
      );
    case 'path-ok':
      return null;
    default:
      return null;
  }
};
