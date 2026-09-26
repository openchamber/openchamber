import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsAddCard,
  SettingsCard,
  SettingsCardChip,
  SettingsCardIcon,
  SettingsCardPill,
  SettingsCardSearch,
  type SettingsCardAction,
} from '@/components/sections/shared/SettingsCards';
import { useI18n } from '@/lib/i18n';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn } from '@/lib/utils';
import {
  getPluginsConfigDirectory,
  getPluginsScopeKey,
  getPluginUpdateKey,
  usePluginsStore,
  type PluginEntry,
  type PluginFile,
} from '@/stores/usePluginsStore';
import {
  configEntryRuntimeTarget,
  findRuntimeMatches,
  pluginFileRuntimeTarget,
  resolveUpdateFlag,
  type PluginRuntimeTarget,
} from './pluginLoadState';
import { usePluginPackageUpdate, usePluginRuntimeStatus } from './usePluginRuntimeStatus';

/**
 * Status pills for one plugin: how OpenCode loaded it, whether a newer release
 * is out, and whether the registry could not resolve the spec at all.
 */
const PluginPills: React.FC<{ target: PluginRuntimeTarget | null; spec?: string }> = ({ target, spec }) => {
  const { t } = useI18n();
  const status = usePluginRuntimeStatus(target);
  const packageUpdate = usePluginPackageUpdate(target);
  const registry = usePluginsStore((state) => (spec ? state.registryInfo[spec] : undefined));

  const registryInvalid = registry?.kind === 'npm-missing-package'
    || registry?.kind === 'npm-missing-version'
    || registry?.kind === 'npm-malformed'
    || registry?.kind === 'path-missing'
    || registry?.kind === 'path-unreadable';
  const updating = status.kind === 'known' && (status.update === 'updating' || packageUpdate?.kind === 'running');
  const updateAvailable = !updating && (
    (registry?.kind === 'npm-ok' && registry.hasUpdate)
    || (status.kind === 'known' && status.update === 'available')
  );

  return (
    <>
      {registryInvalid ? <SettingsCardPill tone="error">{t('settings.plugins.registry.banner.invalid.title')}</SettingsCardPill> : null}
      {status.kind === 'known' && !registryInvalid ? (
        updating ? (
          <SettingsCardPill tone="neutral">{t('settings.plugins.update.running')}</SettingsCardPill>
        ) : status.load.kind === 'failed' ? (
          <SettingsCardPill tone="error">{t('settings.plugins.status.failed.title')}</SettingsCardPill>
        ) : status.load.kind === 'notReported' ? (
          <SettingsCardPill tone="neutral">{t('settings.plugins.status.notReported.title')}</SettingsCardPill>
        ) : (
          <SettingsCardPill tone="success">{t('settings.plugins.status.loaded')}</SettingsCardPill>
        )
      ) : null}
      {updateAvailable ? <SettingsCardPill tone="info">{t('settings.plugins.update.available.title')}</SettingsCardPill> : null}
    </>
  );
};

export type PluginDeleteTarget = { kind: 'entry' | 'file'; id: string; label: string };

type GridItem =
  | { kind: 'entry'; entry: PluginEntry }
  | { kind: 'file'; file: PluginFile };

/** Browse view of the Plugins page: config entries and plugin files as cards. */
export const PluginsGrid: React.FC<{
  onAdd: () => void;
  onDelete: (target: PluginDeleteTarget) => void;
}> = ({ onAdd, onDelete }) => {
  const { t } = useI18n();
  const { entries, files, setSelected, loadPlugins } = usePluginsStore(useShallow((state) => ({
    entries: state.entries,
    files: state.files,
    setSelected: state.setSelected,
    loadPlugins: state.loadPlugins,
  })));
  const isLoadingRegistry = usePluginsStore((state) => state.isLoadingRegistry);
  const loadRegistryInfo = usePluginsStore((state) => state.loadRegistryInfo);
  const isCheckingUpdates = usePluginsStore((state) => state.isCheckingUpdates);
  const checkUpdates = usePluginsStore((state) => state.checkUpdates);
  const runtime = usePluginsStore((state) => state.runtime);
  const registryInfo = usePluginsStore((state) => state.registryInfo);
  const packageUpdates = usePluginsStore((state) => state.packageUpdates);
  const updateToLatest = usePluginsStore((state) => state.updateToLatest);
  const updatePackage = usePluginsStore((state) => state.updatePackage);
  const runtimeScope = getPluginsScopeKey(getPluginsConfigDirectory());
  const runtimeUnavailable = runtime.kind === 'failed' && runtime.scope === runtimeScope;
  const runtimePlugins = runtime.kind === 'ready' && runtime.scope === runtimeScope ? runtime.plugins : null;
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  // The npm registry answers for exact pins (rewritten in config), OpenCode
  // for everything it can reinstall in place (names, ranges, tags, Git).
  const handleRefresh = async () => {
    toast.info(t('settings.plugins.toast.refreshing'));
    const [registryOk, checkOk] = await Promise.all([
      loadRegistryInfo({ force: true }),
      checkUpdates(),
    ]);
    if (!registryOk) toast.error(t('settings.plugins.toast.refreshFailed'));
    if (!checkOk) toast.error(t('settings.plugins.toast.checkFailed'));
  };

  // One stable target per card, so each card's status hook memoizes.
  const runtimeTargets = React.useMemo(() => {
    const targets = new Map<string, PluginRuntimeTarget | null>();
    for (const entry of entries) targets.set(entry.id, configEntryRuntimeTarget(entry.spec, entry.sourcePath));
    for (const file of files) targets.set(file.id, pluginFileRuntimeTarget(file.absolutePath));
    return targets;
  }, [entries, files]);

  // The package OpenCode can reinstall in place for this entry, when a newer
  // release matches its spec and no update is already running.
  const openCodeUpdateTarget = (entryId: string): string | null => {
    const target = runtimeTargets.get(entryId);
    if (!runtimePlugins || target?.kind !== 'package') return null;
    if (packageUpdates[getPluginUpdateKey(runtimeScope, target.target)]?.kind === 'running') return null;
    return resolveUpdateFlag(findRuntimeMatches(target, runtimePlugins)) === 'available' ? target.target : null;
  };

  // The npm registry answers for exact pins (rewritten in config), OpenCode
  // for everything it can reinstall in place (names, ranges, tags, Git).
  const entryActions = (entry: PluginEntry): SettingsCardAction[] => {
    const actions: SettingsCardAction[] = [];
    const info = registryInfo[entry.spec];
    const updateTarget = openCodeUpdateTarget(entry.id);
    if (info?.kind === 'npm-ok' && info.hasUpdate && info.latestVersion) {
      const latest = info.latestVersion;
      actions.push({
        label: t('settings.plugins.registry.banner.updateAvailable.action', { latest }),
        icon: 'arrow-up-s',
        onSelect: () => {
          void updateToLatest(entry.id).then((result) => {
            if (result.ok) toast.success(t('settings.plugins.toast.updatedToLatest', { version: latest }));
            else toast.error(t('settings.plugins.toast.refreshFailed'));
          });
        },
      });
    } else if (updateTarget) {
      actions.push({
        label: t('settings.plugins.update.action'),
        icon: 'arrow-up-s',
        onSelect: () => {
          void updatePackage(updateTarget).then((ok) => {
            if (ok) toast.success(t('settings.plugins.update.toast.done', { name: entry.spec }));
            else toast.error(t('settings.plugins.update.toast.failed', { name: entry.spec }));
          });
        },
      });
    }
    actions.push({
      label: t('settings.common.actions.delete'),
      icon: 'delete-bin',
      destructive: true,
      onSelect: () => onDelete({ kind: 'entry', id: entry.id, label: entry.spec }),
    });
    return actions;
  };

  const items: GridItem[] = [
    ...entries.map((entry): GridItem => ({ kind: 'entry', entry })),
    ...files.map((file): GridItem => ({ kind: 'file', file })),
  ];
  const filtered = rankByQuery(items, query, (item) => (
    item.kind === 'entry' ? [item.entry.spec] : [item.file.fileName, item.file.absolutePath ?? '']
  ));
  const hasQuery = query.trim().length > 0;
  const refreshing = isLoadingRegistry || isCheckingUpdates;

  return (
    <SettingsPageLayout
      title={t('settings.page.plugins.title')}
      description={t('settings.plugins.grid.description')}
      headerEnd={(
        <div className="flex items-center gap-2">
          {runtimeUnavailable ? (
            <span className="inline-flex items-center gap-1 typography-meta text-muted-foreground">
              <Icon name="question" className="size-3.5" />
              {t('settings.plugins.status.sidebar.unavailable')}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted-foreground"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            aria-label={t('settings.plugins.sidebar.actions.refresh')}
            title={t('settings.plugins.sidebar.actions.refresh')}
          >
            <Icon name="refresh" className={cn('size-4', refreshing && 'animate-spin')} />
          </Button>
        </div>
      )}
    >
      {items.length > 0 ? (
        <SettingsCardSearch value={query} onChange={setQuery} placeholder={t('settings.plugins.grid.searchPlaceholder')} />
      ) : null}

      {items.length === 0 ? (
        <p className="py-6 typography-meta text-muted-foreground">{t('settings.plugins.grid.empty')}</p>
      ) : filtered.length === 0 ? (
        <p className="py-6 typography-meta text-muted-foreground">{t('settings.plugins.grid.noMatches', { query: query.trim() })}</p>
      ) : null}

      <div className={SETTINGS_CARD_GRID_CLASS}>
        {hasQuery ? null : (
          <SettingsAddCard
            label={t('settings.plugins.sidebar.actions.addTitle')}
            hint={t('settings.plugins.grid.addHint')}
            onClick={onAdd}
            settingsItem="plugins.create"
          />
        )}
        {filtered.map((item) => {
          if (item.kind === 'entry') {
            const { entry } = item;
            return (
              <SettingsCard
                key={entry.id}
                icon={<SettingsCardIcon name={entry.parsedKind === 'npm' ? 'code-box' : 'folder'} />}
                title={entry.spec}
                badges={<PluginPills target={runtimeTargets.get(entry.id) ?? null} spec={entry.spec} />}
                footer={(
                  <>
                    <span>{entry.parsedKind === 'npm' ? t('settings.plugins.sidebar.kind.npm') : t('settings.plugins.sidebar.kind.path')}</span>
                    {entry.scope === 'project' ? <SettingsCardChip>{t('settings.plugins.grid.scope.project')}</SettingsCardChip> : null}
                  </>
                )}
                onOpen={() => setSelected(entry.id)}
                actionsLabel={t('settings.plugins.grid.actionsAria', { name: entry.spec })}
                actions={entryActions(entry)}
              />
            );
          }
          const { file } = item;
          // A plugin package directory is OpenCode's to load and ours only to
          // show: nothing to open or delete here.
          const displayOnly = file.kind === 'package';
          return (
            <SettingsCard
              key={file.id}
              icon={<SettingsCardIcon name={displayOnly ? 'folder' : 'file-text'} />}
              title={file.fileName}
              badges={<PluginPills target={runtimeTargets.get(file.id) ?? null} />}
              footer={(
                <>
                  <span>{displayOnly ? t('settings.plugins.sidebar.kind.package') : t('settings.plugins.sidebar.kind.file')}</span>
                  {file.scope === 'project' ? <SettingsCardChip>{t('settings.plugins.grid.scope.project')}</SettingsCardChip> : null}
                </>
              )}
              onOpen={displayOnly ? undefined : () => setSelected(file.id)}
              actionsLabel={t('settings.plugins.grid.actionsAria', { name: file.fileName })}
              actions={displayOnly ? undefined : [{
                label: t('settings.common.actions.delete'),
                icon: 'delete-bin',
                destructive: true,
                onSelect: () => onDelete({ kind: 'file', id: file.id, label: file.fileName }),
              }]}
            />
          );
        })}
      </div>
    </SettingsPageLayout>
  );
};
