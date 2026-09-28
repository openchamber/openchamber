import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { errorToastKey, updateErrorToastKey } from '@/components/sections/extensions/extensionToasts';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { guestNeedsApproval } from '@/lib/guests/capabilities';
import { installGuest, setGuestEnabled, uninstallGuest } from '@/lib/guests/install';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import { useGuestsStore } from '@/lib/guests/store';
import { closeGuestTabsById } from '@/lib/guests/tabs';
import { updateGuest } from '@/lib/guests/updates';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { openExternalUrl } from '@/lib/url';
import { useUIStore } from '@/stores/useUIStore';
import {
  CATALOG_EXTENSIONS,
  getCatalogExtensionState,
  type CatalogExtensionDefinition,
  type CatalogExtensionState,
} from './catalogExtensions';
import { IntegrationCatalogCard, type IntegrationCatalogStatusTone } from './IntegrationCatalogCard';

type PendingAction = 'install' | 'update' | 'enable' | 'remove';

type CardStatus = { status: string; tone: IntegrationCatalogStatusTone };

interface CatalogExtensionsSectionProps {
  divider?: boolean;
}

/**
 * OpenChamber extensions the team publishes (Excalidraw today), offered with a
 * one-click Git install. The installed extension is an ordinary entry in
 * Settings → Extensions; these cards read the same catalog. Hidden where the
 * runtime loads no extensions (VS Code, mobile).
 */
export const CatalogExtensionsSection: React.FC<CatalogExtensionsSectionProps> = ({ divider = true }) => {
  const { t } = useI18n();
  const guests = useGuestsStore((state) => state.guests);
  const catalogStatus = useGuestsStore((state) => state.status);
  const [pending, setPending] = React.useState<{ guestId: string; action: PendingAction } | null>(null);
  const [openIds, setOpenIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [removeTarget, setRemoveTarget] = React.useState<CatalogExtensionDefinition | null>(null);

  React.useEffect(() => {
    void loadGuestCatalog();
  }, []);

  const openExtensionsPage = React.useCallback(() => {
    useUIStore.getState().requestSettingsJump('extensions');
  }, []);

  // A reply that lands after a runtime switch belongs to the old server.
  const run = React.useCallback(async (
    definition: CatalogExtensionDefinition,
    action: PendingAction,
    perform: () => Promise<void>,
  ) => {
    const runtimeKey = getRuntimeKey();
    setPending({ guestId: definition.guestId, action });
    try {
      await perform();
      if (getRuntimeKey() === runtimeKey) await loadGuestCatalog();
    } finally {
      setPending(null);
    }
  }, []);

  const install = (definition: CatalogExtensionDefinition) => run(definition, 'install', async () => {
    const result = await installGuest(definition.gitUrl);
    if (!result.ok) {
      toast.error(result.code === 'host-too-old' && result.required
        ? t('settings.extensions.toast.hostTooOld', { version: result.required })
        : t(errorToastKey(result.code)));
      return;
    }
    toast.success(t('settings.integrations.thirdParty.toast.installed', { name: t(definition.nameKey) }));
    // The approval dialog lives in Settings → Extensions.
    if (guestNeedsApproval(result.guest)) openExtensionsPage();
  });

  const update = (definition: CatalogExtensionDefinition) => run(definition, 'update', async () => {
    const result = await updateGuest(definition.guestId);
    if (!result.ok) {
      toast.error(result.code === 'host-too-old' && result.required
        ? t('settings.extensions.toast.hostTooOld', { version: result.required })
        : t(updateErrorToastKey(result.code)));
      return;
    }
    closeGuestTabsById(definition.guestId);
    toast.success(t('settings.integrations.thirdParty.toast.updated', { name: t(definition.nameKey) }));
    if (guestNeedsApproval(result.guest)) openExtensionsPage();
  });

  const enable = (definition: CatalogExtensionDefinition) => run(definition, 'enable', async () => {
    const ok = await setGuestEnabled(definition.guestId, true);
    if (!ok) {
      toast.error(t('settings.integrations.extensionCatalog.toast.enableFailed', { name: t(definition.nameKey) }));
      return;
    }
    toast.success(t('settings.integrations.extensionCatalog.toast.enabled', { name: t(definition.nameKey) }));
  });

  const remove = async () => {
    const definition = removeTarget;
    if (!definition) return;
    setRemoveTarget(null);
    await run(definition, 'remove', async () => {
      const result = await uninstallGuest(definition.guestId);
      if (!result.ok) {
        toast.error(t('settings.integrations.thirdParty.toast.actionFailed'));
        return;
      }
      closeGuestTabsById(definition.guestId);
      toast.success(t('settings.integrations.thirdParty.toast.removed', { name: t(definition.nameKey) }));
    });
  };

  const describeState = (state: CatalogExtensionState): CardStatus => {
    switch (state.kind) {
      case 'not-installed':
        return { status: t('settings.integrations.thirdParty.status.notInstalled'), tone: 'neutral' };
      case 'needs-approval':
        return { status: t('settings.integrations.extensionCatalog.status.needsApproval'), tone: 'warning' };
      case 'paused':
        return { status: t('settings.integrations.extensionCatalog.status.paused'), tone: 'neutral' };
      case 'update-available':
        return { status: t('settings.integrations.thirdParty.status.updateAvailable', { version: state.version }), tone: 'warning' };
      case 'installed':
        return {
          status: state.guest.version
            ? t('settings.integrations.thirdParty.status.installedVersion', { version: state.guest.version })
            : t('settings.integrations.thirdParty.status.installed'),
          tone: 'success',
        };
    }
  };

  const renderCard = (definition: CatalogExtensionDefinition) => {
    const state = getCatalogExtensionState(guests, definition);
    // Until the catalog answers, "not installed" would be a guess.
    const catalogLoading = catalogStatus === 'idle' || catalogStatus === 'loading';
    const { status, tone } = catalogLoading ? { status: t('common.loading'), tone: 'neutral' as const } : describeState(state);
    const busy = pending?.guestId === definition.guestId || catalogLoading;
    const open = openIds.has(definition.guestId);
    const spinner = <Icon name="loader-4" className="size-3.5 animate-spin" />;

    const primary = state.kind === 'not-installed'
      ? { label: t('settings.integrations.thirdParty.actions.install'), onClick: () => void install(definition), variant: 'default' as const }
      : state.kind === 'update-available'
        ? { label: t('settings.integrations.thirdParty.actions.update'), onClick: () => void update(definition), variant: 'default' as const }
        : state.kind === 'paused'
          ? { label: t('settings.integrations.extensionCatalog.actions.enable'), onClick: () => void enable(definition), variant: 'default' as const }
          : state.kind === 'needs-approval'
            ? { label: t('settings.integrations.extensionCatalog.actions.manage'), onClick: openExtensionsPage, variant: 'outline' as const }
            : null;

    return (
      <IntegrationCatalogCard
        key={definition.guestId}
        settingsItem={`integrations.extensions.${definition.guestId}`}
        logo={<FileTypeIcon filePath={definition.logoFileName} className="size-5" />}
        name={t(definition.nameKey)}
        description={t(definition.descriptionKey)}
        status={status}
        statusTone={tone}
        open={open}
        onOpenChange={(next) => setOpenIds((current) => {
          const ids = new Set(current);
          if (next) ids.add(definition.guestId);
          else ids.delete(definition.guestId);
          return ids;
        })}
      >
        <div className="flex flex-wrap items-center gap-2">
          {primary ? (
            <Button type="button" size="sm" variant={primary.variant} onClick={primary.onClick} disabled={busy}>
              {busy ? spinner : null}
              {primary.label}
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="secondary" onClick={() => void openExternalUrl(definition.homepage)}>
            <Icon name="external-link" className="size-3.5" />
            {t('settings.integrations.thirdParty.actions.docs')}
          </Button>
          {state.kind !== 'not-installed' ? (
            <Button type="button" size="sm" variant="destructive" onClick={() => setRemoveTarget(definition)} disabled={busy}>
              <Icon name="delete-bin" className="size-3.5" />
              {t('settings.integrations.thirdParty.actions.remove')}
            </Button>
          ) : null}
        </div>
      </IntegrationCatalogCard>
    );
  };

  if (catalogStatus === 'unsupported') return null;

  return (
    <>
      <SettingsSection
        title={t('settings.integrations.extensionCatalog.title')}
        info={t('settings.integrations.extensionCatalog.info')}
        divider={divider}
        settingsItem="integrations.extensions"
        contentClassName="space-y-3"
      >
        {CATALOG_EXTENSIONS.map(renderCard)}
      </SettingsSection>

      <Dialog open={removeTarget !== null} onOpenChange={(next) => !next && setRemoveTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.integrations.extensionCatalog.dialog.remove.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.integrations.extensionCatalog.dialog.remove.description', {
                name: removeTarget ? t(removeTarget.nameKey) : '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRemoveTarget(null)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button type="button" size="sm" variant="destructive" onClick={() => void remove()}>
              {t('settings.integrations.thirdParty.actions.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
