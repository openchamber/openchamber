import React from 'react';
import { useShallow } from 'zustand/react/shallow';
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
import { Icon } from '@/components/icon/Icon';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import {
  usePluginsStore,
  type PluginMutationResult,
} from '@/stores/usePluginsStore';
import { usePendingOpenCodeRestartStore } from '@/stores/usePendingOpenCodeRestartStore';
import {
  getCatalogPluginPrimaryAction,
  getCatalogPluginPresentation,
  getCatalogPluginState,
  getLatestNpmSpec,
  THIRD_PARTY_PLUGINS,
  type ThirdPartyPluginDefinition,
} from './thirdPartyPlugins';

type PendingAction = 'install' | 'update' | 'setup' | 'remove';

type RemoveTarget = ThirdPartyPluginDefinition | null;

interface ThirdPartyIntegrationsSectionProps {
  onOpenProviderSetup: (providerId: string) => Promise<boolean>;
  onOpenPluginManager: () => void;
}

const requiresRestart = (result: PluginMutationResult): boolean =>
  result.restartDeferred === true
  || result.requiresManualRestart === true
  || result.reloadFailed === true;

export const ThirdPartyIntegrationsSection: React.FC<ThirdPartyIntegrationsSectionProps> = ({
  onOpenProviderSetup,
  onOpenPluginManager,
}) => {
  const { t } = useI18n();
  const {
    entries,
    registryInfo,
    loadPlugins,
    loadRegistryInfo,
    createEntry,
    updateEntry,
    deleteEntry,
  } = usePluginsStore(
    useShallow((state) => ({
      entries: state.entries,
      registryInfo: state.registryInfo,
      loadPlugins: state.loadPlugins,
      loadRegistryInfo: state.loadRegistryInfo,
      createEntry: state.createEntry,
      updateEntry: state.updateEntry,
      deleteEntry: state.deleteEntry,
    })),
  );

  const [registryLoadFailed, setRegistryLoadFailed] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<{
    pluginId: string;
    action: PendingAction;
  } | null>(null);
  const [restartRequiredIds, setRestartRequiredIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [providerUnavailableIds, setProviderUnavailableIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [removeTarget, setRemoveTarget] = React.useState<RemoveTarget>(null);
  const [openPluginIds, setOpenPluginIds] = React.useState<ReadonlySet<string>>(() => new Set());

  const refresh = React.useCallback(async () => {
    const pluginsLoaded = await loadPlugins({ force: true });
    if (!pluginsLoaded) {
      setRegistryLoadFailed(true);
      return;
    }

    const latestEntries = usePluginsStore.getState().entries;
    const specs = new Set(THIRD_PARTY_PLUGINS.map((plugin) => plugin.packageName));
    for (const entry of latestEntries) {
      if (THIRD_PARTY_PLUGINS.some((plugin) => entry.spec === plugin.packageName || entry.spec.startsWith(`${plugin.packageName}@`))) {
        specs.add(entry.spec);
      }
    }
    const registryLoaded = await loadRegistryInfo({ specs: [...specs], force: true });
    setRegistryLoadFailed(!registryLoaded);
  }, [loadPlugins, loadRegistryInfo]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const pendingPluginRestartCount = usePendingOpenCodeRestartStore(
    (state) => state.changes.filter((change) => change.scope === 'plugins').length,
  );
  const isApplyingRestart = usePendingOpenCodeRestartStore((state) => state.isApplying);
  const previousPluginRestartCountRef = React.useRef(pendingPluginRestartCount);

  // When deferred plugin restarts are applied (pending plugins scope clears), drop
  // local restart/unavailable flags and reload so statuses update immediately.
  React.useEffect(() => {
    const previousCount = previousPluginRestartCountRef.current;
    previousPluginRestartCountRef.current = pendingPluginRestartCount;

    if (isApplyingRestart) {
      return;
    }
    if (previousCount <= 0 || pendingPluginRestartCount > 0) {
      return;
    }

    setRestartRequiredIds(new Set());
    setProviderUnavailableIds(new Set());
    void refresh();
  }, [isApplyingRestart, pendingPluginRestartCount, refresh]);

  const setRestartRequired = React.useCallback((pluginId: string, required: boolean) => {
    setRestartRequiredIds((current) => {
      const next = new Set(current);
      if (required) next.add(pluginId);
      else next.delete(pluginId);
      return next;
    });
  }, []);

  const setProviderUnavailable = React.useCallback((pluginId: string, unavailable: boolean) => {
    setProviderUnavailableIds((current) => {
      const next = new Set(current);
      if (unavailable) next.add(pluginId);
      else next.delete(pluginId);
      return next;
    });
  }, []);

  const runMutation = React.useCallback(async (
    plugin: ThirdPartyPluginDefinition,
    action: Exclude<PendingAction, 'setup'>,
    run: () => Promise<PluginMutationResult>,
  ) => {
    setPendingAction({ pluginId: plugin.id, action });
    try {
      const result = await run();
      if (!result.ok) {
        toast.error(t('settings.integrations.thirdParty.toast.actionFailed'));
        return;
      }

      setProviderUnavailable(plugin.id, false);
      const restartNeeded = requiresRestart(result);
      setRestartRequired(plugin.id, restartNeeded);
      const toastOptions = restartNeeded
        ? { description: t('settings.integrations.thirdParty.toast.restartRequired') }
        : undefined;
      if (action === 'install') {
        toast.success(t('settings.integrations.thirdParty.toast.installed', { name: t(plugin.nameKey) }), toastOptions);
      } else if (action === 'update') {
        toast.success(t('settings.integrations.thirdParty.toast.updated', { name: t(plugin.nameKey) }), toastOptions);
      } else {
        toast.success(t('settings.integrations.thirdParty.toast.removed', { name: t(plugin.nameKey) }), toastOptions);
      }
      await refresh();
    } finally {
      setPendingAction(null);
    }
  }, [refresh, setProviderUnavailable, setRestartRequired, t]);

  const handlePrimaryAction = React.useCallback(async (plugin: ThirdPartyPluginDefinition) => {
    const state = getCatalogPluginState(entries, plugin.packageName, registryInfo);
    const action = getCatalogPluginPrimaryAction(state, plugin.packageName);

    if (action === 'manage') {
      onOpenPluginManager();
      return;
    }

    if (action === 'setup') {
      setPendingAction({ pluginId: plugin.id, action });
      try {
        const opened = await onOpenProviderSetup(plugin.providerId);
        setProviderUnavailable(plugin.id, !opened);
        if (!opened) {
          toast.error(t('settings.integrations.thirdParty.toast.providerUnavailable'));
        }
      } finally {
        setPendingAction(null);
      }
      return;
    }

    const latestSpec = getLatestNpmSpec(plugin.packageName, state.registry);
    if (!latestSpec) {
      setRegistryLoadFailed(true);
      return;
    }

    if (action === 'install') {
      await runMutation(plugin, 'install', () => createEntry({ spec: latestSpec, scope: 'user' }));
      return;
    }

    if (state.userEntry) {
      await runMutation(plugin, 'update', () => updateEntry(state.userEntry!.id, { spec: latestSpec }));
    }
  }, [createEntry, entries, onOpenPluginManager, onOpenProviderSetup, registryInfo, runMutation, setProviderUnavailable, t, updateEntry]);

  const handleRemove = React.useCallback(async () => {
    const plugin = removeTarget;
    if (!plugin) return;
    const state = getCatalogPluginState(entries, plugin.packageName, registryInfo);
    if (!state.userEntry || state.userEntryIsAmbiguous) {
      setRemoveTarget(null);
      onOpenPluginManager();
      return;
    }
    setRemoveTarget(null);
    await runMutation(plugin, 'remove', () => deleteEntry(state.userEntry!.id));
  }, [deleteEntry, entries, onOpenPluginManager, registryInfo, removeTarget, runMutation]);

  const setPluginOpen = React.useCallback((pluginId: string, open: boolean) => {
    setOpenPluginIds((current) => {
      const next = new Set(current);
      if (open) next.add(pluginId);
      else next.delete(pluginId);
      return next;
    });
  }, []);

  const renderPlugin = (plugin: ThirdPartyPluginDefinition) => {
    const state = getCatalogPluginState(entries, plugin.packageName, registryInfo);
    const primaryAction = getCatalogPluginPrimaryAction(state, plugin.packageName);
    const latestSpec = getLatestNpmSpec(plugin.packageName, state.registry);
    const isPending = pendingAction?.pluginId === plugin.id;
    const isRestartRequired = restartRequiredIds.has(plugin.id);
    const isProviderUnavailable = providerUnavailableIds.has(plugin.id);
    const registryUnavailable = registryLoadFailed || state.registry?.kind === 'npm-network';
    const actionDisabled = isPending
      || isRestartRequired
      || ((primaryAction === 'install' || primaryAction === 'update') && (registryUnavailable || !latestSpec));
    const presentation = getCatalogPluginPresentation(state, {
      registryUnavailable,
      restartRequired: isRestartRequired,
      providerUnavailable: isProviderUnavailable,
    });
    let status: string;
    switch (presentation.status) {
      case 'installed-version':
        status = presentation.latestVersion
          ? t('settings.integrations.thirdParty.status.installedVersion', {
            version: presentation.latestVersion,
          })
          : t('settings.integrations.thirdParty.status.installed');
        break;
      case 'update-available':
        status = presentation.latestVersion
          ? t('settings.integrations.thirdParty.status.updateAvailable', {
            version: presentation.latestVersion,
          })
          : t('settings.integrations.thirdParty.status.unpinned');
        break;
      case 'not-installed':
        status = t('settings.integrations.thirdParty.status.notInstalled');
        break;
      case 'installed':
        status = t('settings.integrations.thirdParty.status.installed');
        break;
      case 'unpinned':
        status = t('settings.integrations.thirdParty.status.unpinned');
        break;
      case 'ambiguous':
        status = t('settings.integrations.thirdParty.status.ambiguous');
        break;
      case 'restart-required':
        status = t('settings.integrations.thirdParty.status.restartRequired');
        break;
      case 'registry-unavailable':
        status = t('settings.integrations.thirdParty.status.registryUnavailable');
        break;
      case 'provider-unavailable':
        status = t('settings.integrations.thirdParty.status.providerUnavailable');
        break;
    }
    const statusClassName = presentation.status === 'installed-version'
      ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]'
      : presentation.status === 'update-available'
        || presentation.status === 'ambiguous'
        || presentation.status === 'restart-required'
        || presentation.status === 'registry-unavailable'
        || presentation.status === 'provider-unavailable'
        ? 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]'
        : 'bg-[var(--surface-muted)] text-muted-foreground';

    const primaryLabel = {
      install: t('settings.integrations.thirdParty.actions.install'),
      update: t('settings.integrations.thirdParty.actions.update'),
      setup: t('settings.integrations.thirdParty.actions.setup'),
      manage: t('settings.integrations.thirdParty.actions.managePlugins'),
    }[primaryAction];

    const open = openPluginIds.has(plugin.id);

    return (
      <Collapsible
        key={plugin.id}
        open={open}
        onOpenChange={(nextOpen) => setPluginOpen(plugin.id, nextOpen)}
      >
        <div
          data-settings-item={`integrations.third-party.${plugin.id}`}
          className="overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)]"
        >
          <CollapsibleTrigger
            className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-[var(--interactive-hover)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
          >
            <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-muted)]">
              <Icon name={plugin.icon} className={cn('size-5', plugin.brandClassName)} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">{t(plugin.nameKey)}</div>
              <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-muted-foreground">
                {t(plugin.descriptionKey)}
              </p>
            </div>
            <span
              aria-live="polite"
              className={cn(
                'max-w-36 shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-medium',
                statusClassName,
              )}
            >
              {status}
            </span>
            <Icon
              name="arrow-down-s"
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none',
                open && 'rotate-180',
              )}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t border-[var(--interactive-border)] px-4 py-4">
            <div className="space-y-3">
              {state.projectEntries.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('settings.integrations.thirdParty.status.projectInstalled')}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={primaryAction === 'manage' ? 'outline' : 'default'}
                  onClick={() => void handlePrimaryAction(plugin)}
                  disabled={actionDisabled}
                >
                  {isPending ? (
                    <Icon name="loader-4" className="size-3.5 animate-spin" />
                  ) : primaryAction === 'setup' ? (
                    <Icon name="plug-2" className="size-3.5" />
                  ) : null}
                  {primaryLabel}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => void openExternalUrl(plugin.homepage)}
                >
                  <Icon name="external-link" className="size-3.5" />
                  {t('settings.integrations.thirdParty.actions.docs')}
                </Button>
                {state.userEntry && !state.userEntryIsAmbiguous ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => setRemoveTarget(plugin)}
                    disabled={isPending}
                  >
                    <Icon name="delete-bin" className="size-3.5" />
                    {t('settings.integrations.thirdParty.actions.remove')}
                  </Button>
                ) : null}
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    );
  };

  return (
    <>
      <SettingsSection
        title={t('settings.integrations.thirdParty.title')}
        info={t('settings.integrations.thirdParty.info')}
        settingsItem="integrations.third-party"
        contentClassName="space-y-3"
      >
        {THIRD_PARTY_PLUGINS.map(renderPlugin)}
      </SettingsSection>

      <Dialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.integrations.thirdParty.dialog.remove.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.integrations.thirdParty.dialog.remove.description', {
                name: removeTarget ? t(removeTarget.nameKey) : '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRemoveTarget(null)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button type="button" size="sm" variant="destructive" onClick={() => void handleRemove()}>
              {t('settings.integrations.thirdParty.actions.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
