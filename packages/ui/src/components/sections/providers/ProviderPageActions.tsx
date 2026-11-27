import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { providerLogoUploadSupported, removeProviderLogo } from '@/lib/customProviderLogos';
import { loadIntegrationCatalog } from '@/lib/opencode/integration-catalog';
import { useUIStore } from '@/stores/useUIStore';
import { removeProviderFromConfig, type ProviderSources } from './providerSource';
import { removeProviderCredentials } from './provider-key-writes';

interface ProviderPageActionsProps {
  providerId: string;
  providerName: string;
  removableFrom: ProviderSources | null;
  directory: string | null;
  onEdit: (() => void) | null;
  onDisable: (() => void) | null;
  onRemoveSettled: (removed: boolean) => void;
}

async function clearProviderAppearance(providerId: string) {
  const ui = useUIStore.getState();
  try {
    if (ui.customProviderIcons[providerId]) {
      const icons = { ...ui.customProviderIcons };
      delete icons[providerId];
      await updateDesktopSettings({ customProviderIcons: icons });
      ui.setCustomProviderIcon(providerId, null);
    }
    if (ui.customProviderLogos[providerId] && providerLogoUploadSupported()) {
      await removeProviderLogo(providerId);
      ui.setCustomProviderLogo(providerId, null);
    }
  } catch (error) {
    console.warn('[providers] could not clear the removed provider\'s icon or logo:', error);
  }
}

export const ProviderPageActions: React.FC<ProviderPageActionsProps> = ({
  providerId, providerName, removableFrom, directory, onEdit, onDisable, onRemoveSettled,
}) => {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirmDialog();
  const [removing, setRemoving] = React.useState(false);

  const remove = async (sources: ProviderSources) => {
    const files = [sources.custom, sources.project, sources.user]
      .flatMap((source) => (source?.exists && source.path ? [source.path] : []));
    const confirmed = await confirm({
      title: t('settings.providers.remove.confirm.title', { provider: providerName }),
      message: t('settings.providers.remove.confirm.message', { files: files.join('\n') }),
      action: t('settings.providers.remove.confirm.action'),
      destructive: true,
    });
    if (!confirmed) return;

    setRemoving(true);
    let removed = false;
    try {
      const { integrations } = await loadIntegrationCatalog(directory);
      await removeProviderCredentials(integrations, providerId);
      removed = await removeProviderFromConfig(
        providerId,
        directory,
        t('settings.providers.remove.toast.failed', { provider: providerName }),
      );
      if (removed) {
        await clearProviderAppearance(providerId);
        toast.success(t('settings.providers.remove.toast.removed', { provider: providerName }));
      } else {
        toast.error(t('settings.providers.remove.toast.notInConfig', { provider: providerName }));
      }
    } catch (error) {
      console.error('Failed to remove provider:', error);
      toast.error(error instanceof Error && error.message
        ? error.message
        : t('settings.providers.remove.toast.failed', { provider: providerName }));
    } finally {
      setRemoving(false);
      onRemoveSettled(removed);
    }
  };

  return (
    <div className="flex items-center gap-1">
      {onEdit ? (
        <Button variant="outline" size="xs" className="!font-normal" onClick={onEdit}>
          {t('settings.providers.page.actions.edit')}
        </Button>
      ) : null}
      {onDisable ? (
        <Button
          variant="outline"
          size="xs"
          className="!font-normal"
          title={t('settings.providers.disabled.disableHint')}
          onClick={onDisable}
        >
          {t('settings.providers.disabled.disable')}
        </Button>
      ) : null}
      {removableFrom ? (
        <Button
          variant="outline"
          size="xs"
          className="!font-normal"
          title={t('settings.providers.remove.hint')}
          disabled={removing}
          onClick={() => void remove(removableFrom)}
        >
          {t('settings.providers.remove.action')}
        </Button>
      ) : null}
      {dialog}
    </div>
  );
};
