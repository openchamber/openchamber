import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { usePluginsStore } from '@/stores/usePluginsStore';

interface RegistryBannerProps {
  entryId: string;
  spec: string;
}

export const RegistryBanner: React.FC<RegistryBannerProps> = ({ entryId, spec }) => {
  const { t } = useI18n();
  const info = usePluginsStore((s) => s.registryInfo[spec]);
  const updateToLatest = usePluginsStore((s) => s.updateToLatest);

  const [isUpdating, setIsUpdating] = React.useState(false);

  if (!info) return null;

  if (info.kind === 'npm-ok') {
    if (!info.hasUpdate || !info.latestVersion) return null;

    const latest = info.latestVersion;
    const current = info.currentVersion ?? '';

    const handleUpdate = async () => {
      setIsUpdating(true);
      try {
        const result = await updateToLatest(entryId);
        if (result.ok) {
          toast.success(
            t('settings.plugins.toast.updatedToLatest', { version: latest }),
          );
        } else {
          toast.error(t('settings.plugins.toast.refreshFailed'));
        }
      } finally {
        setIsUpdating(false);
      }
    };

    return (
      <div className="rounded-md border border-border bg-card p-3 flex items-start gap-3">
        <Icon
          name="arrow-up"
          className="h-5 w-5 text-[var(--status-success)] shrink-0 mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <p className="typography-label text-[var(--status-success)]">
            {t('settings.plugins.registry.banner.updateAvailable.title')}
          </p>
          <p className="typography-micro text-muted-foreground mt-0.5">
            {t('settings.plugins.registry.banner.updateAvailable.description', {
              current,
              latest,
            })}
          </p>
        </div>
        <Button
          variant="default"
          size="sm"
          onClick={() => void handleUpdate()}
          disabled={isUpdating}
        >
          {t('settings.plugins.registry.banner.updateAvailable.action', { latest })}
        </Button>
      </div>
    );
  }

  if (info.kind === 'path-ok') return null;

  if (info.kind === 'npm-network') {
    return (
      <div className="rounded-md border border-border bg-card p-3 flex items-start gap-3">
        <Icon
          name="cloud-off"
          className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <p className="typography-micro text-muted-foreground">
            {t('settings.plugins.registry.badge.network.tooltip')}
          </p>
        </div>
      </div>
    );
  }

  const isWarning = info.kind === 'path-unreadable';
  const colorVar = isWarning ? 'var(--status-warning)' : 'var(--status-error)';
  const iconName = isWarning ? 'alert' : 'error-warning';

  const description = (() => {
    switch (info.kind) {
      case 'npm-missing-version':
        return t('settings.plugins.registry.banner.invalid.missingVersion');
      case 'npm-missing-package':
        return t('settings.plugins.registry.banner.invalid.missingPackage');
      case 'npm-malformed':
        return t('settings.plugins.registry.banner.invalid.malformed');
      case 'path-missing':
        return t('settings.plugins.registry.banner.invalid.pathMissing');
      case 'path-unreadable':
        return t('settings.plugins.registry.banner.invalid.pathUnreadable');
    }
  })();

  return (
    <div className="rounded-md border border-border bg-card p-3 flex items-start gap-3">
      <Icon
        name={iconName}
        className="h-5 w-5 shrink-0 mt-0.5"
        style={{ color: colorVar }}
      />
      <div className="flex-1 min-w-0">
        <p className="typography-label" style={{ color: colorVar }}>
          {t('settings.plugins.registry.banner.invalid.title')}
        </p>
        <p className="typography-micro text-muted-foreground mt-0.5">
          {description}
        </p>
      </div>
    </div>
  );
};
