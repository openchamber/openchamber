import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SETTINGS_DESCRIPTION_CLASS } from '@/components/sections/shared/SettingsSection';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsAddCard,
  SettingsCard,
  SettingsCardChip,
  SettingsCardIcon,
  SettingsCardPill,
  SettingsCardToolbar,
  type SettingsCardAction,
} from '@/components/sections/shared/SettingsCards';
import { useI18n } from '@/lib/i18n';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useIntegrationPolicyState } from '@/components/sections/shared/useIntegrationPolicyBlock';
import {
  getPluginsConfigDirectory,
  getPluginsScopeKey,
  getPluginUpdateKey,
  usePluginsStore,
  type PluginEntry,
  type PluginFile,
  type PluginParsedKind,
} from '@/stores/usePluginsStore';
import {
  configEntryRuntimeTarget,
  findRuntimeMatches,
  pluginFileRuntimeTarget,
  resolveUpdateFlag,
  type PluginRuntimeTarget,
} from './pluginLoadState';
import { pluginDisplayName } from './pluginDisplayName';
import { usePluginPackageUpdate, usePluginRuntimeStatus } from './usePluginRuntimeStatus';

const PARSED_KIND_ICON: Record<PluginParsedKind, IconName> = {
  control: 'equalizer-2',
  npm: 'code-box',
  path: 'folder',
  git: 'git-branch',
};

const PARSED_KIND_LABEL_KEY = {
  npm: 'settings.plugins.sidebar.kind.npm',
  path: 'settings.plugins.sidebar.kind.path',
  git: 'settings.plugins.sidebar.kind.git',
} as const;

const entryKindLabelKey = (entry: PluginEntry) => {
  if (entry.parsedKind !== 'control') return PARSED_KIND_LABEL_KEY[entry.parsedKind];
  return entry.spec.startsWith('-') ? 'settings.plugins.sidebar.kind.disableRule' : 'settings.plugins.sidebar.kind.enableRule';
};

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
  const setEntryEnabled = usePluginsStore((state) => state.setEntryEnabled);
  const setFileEnabled = usePluginsStore((state) => state.setFileEnabled);
  const runtimeScope = getPluginsScopeKey(getPluginsConfigDirectory());
  const runtimeUnavailable = runtime.kind === 'failed' && runtime.scope === runtimeScope;
  const runtimePlugins = runtime.kind === 'ready' && runtime.scope === runtimeScope ? runtime.plugins : null;
  const [query, setQuery] = React.useState('');
  const policyRevision = usePluginsStore((state) => state.policyRevision);
  const bumpPolicyRevision = usePluginsStore((state) => state.bumpPolicyRevision);
  const [pendingSwitchIds, setPendingSwitchIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const setSwitchPending = (id: string, pending: boolean) => {
    setPendingSwitchIds((previous) => {
      if (previous.has(id) === pending) return previous;
      const next = new Set(previous);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const policy = useIntegrationPolicyState(getPluginsConfigDirectory(), policyRevision);

  const toggleSwitch = (id: string, enabled: boolean, setEnabled: typeof setEntryEnabled) => {
    setSwitchPending(id, true);
    void setEnabled(id, enabled).then((result) => {
      setSwitchPending(id, false);
      if (result.switchOverridden) {
        toast.error(t('settings.plugins.switch.overriddenByConfig'));
        void loadPlugins({ force: true });
      } else if (!result.ok) {
        toast.error(t('settings.plugins.switch.toast.failed'));
      } else {
        if (result.requiresManualRestart) toast.info(t('settings.openchamber.opencodeCli.restart.manualRequired'));
        bumpPolicyRevision();
      }
    });
  };

  const pluginSwitch = (
    item: Pick<PluginEntry, 'id' | 'policyResource' | 'switchState'>,
    name: string,
    setEnabled: typeof setEntryEnabled,
  ) => {
    const resource = item.policyResource;
    const switchOff = item.switchState === 'off';
    const blocked = resource
      ? policy.hasRead
        ? switchOff || item.switchState === 'unreadable' ? policy.isBlocked(resource) : policy.isBlockedByRule(resource)
        : switchOff
      : false;
    const overridden = item.switchState === 'overridden'
      || (switchOff && resource !== undefined && policy.status === 'ready' && policy.isAllowedByRule(resource));
    const hint = (() => {
      if (policy.status === 'error') return t('settings.plugins.status.unknown.description');
      if (!resource) return t('settings.plugins.switch.unavailable');
      if (item.switchState === 'unavailable') return t('settings.plugins.switch.notAvailable');
      if (item.switchState === 'unreadable') return t('settings.plugins.switch.unreadable');
      if (overridden) return t('settings.plugins.switch.overriddenByConfig');
      if (policy.status === 'ready' && blocked && !switchOff) return t('settings.plugins.switch.blockedByConfig');
      return null;
    })();
    return {
      blocked,
      control: (
        <div className="flex items-center gap-1">
          {hint ? <SettingsInfoHint contentClassName="max-w-64">{hint}</SettingsInfoHint> : null}
          <Switch
            checked={overridden || (!blocked && !switchOff)}
            disabled={pendingSwitchIds.has(item.id) || !resource || policy.status !== 'ready' || item.switchState === 'unavailable' || item.switchState === 'unreadable' || overridden || (blocked && !switchOff)}
            onCheckedChange={() => toggleSwitch(item.id, switchOff, setEnabled)}
            aria-label={`${name}: ${t('settings.plugins.switch.label')}`}
          />
        </div>
      ),
    };
  };

  React.useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const handleRefresh = async () => {
    toast.info(t('settings.plugins.toast.refreshing'));
    bumpPolicyRevision();
    const [registryOk, checkOk] = await Promise.all([
      loadRegistryInfo({ force: true }),
      checkUpdates(),
    ]);
    if (!registryOk) toast.error(t('settings.plugins.toast.refreshFailed'));
    if (!checkOk) toast.error(t('settings.plugins.toast.checkFailed'));
  };

  const runtimeTargets = React.useMemo(() => {
    const targets = new Map<string, PluginRuntimeTarget | null>();
    for (const entry of entries) {
      targets.set(entry.id, entry.parsedKind === 'control' ? null : configEntryRuntimeTarget(entry.spec, entry.sourcePath));
    }
    for (const file of files) targets.set(file.id, pluginFileRuntimeTarget(file.absolutePath));
    return targets;
  }, [entries, files]);

  const openCodeUpdateTarget = (entryId: string): string | null => {
    const target = runtimeTargets.get(entryId);
    if (!runtimePlugins || target?.kind !== 'package') return null;
    if (packageUpdates[getPluginUpdateKey(runtimeScope, target.target)]?.kind === 'running') return null;
    return resolveUpdateFlag(findRuntimeMatches(target, runtimePlugins)) === 'available' ? target.target : null;
  };

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

  const declaredResources = new Map<string, Set<string | undefined>>();
  for (const entry of entries) {
    const target = entry.resolvedPath ? pluginFileRuntimeTarget(entry.resolvedPath) : runtimeTargets.get(entry.id);
    if (target?.kind !== 'local') continue;
    const resources = declaredResources.get(target.path) ?? new Set();
    resources.add(entry.policyResource);
    declaredResources.set(target.path, resources);
  }
  const visibleFiles = files.filter((file) => {
    if (file.kind !== 'package') return true;
    const target = pluginFileRuntimeTarget(file.resolvedPath ?? file.absolutePath);
    if (target?.kind !== 'local') return true;
    const resources = declaredResources.get(target.path);
    if (!resources) return true;
    const sameSwitch = !file.policyResource || resources.has(undefined) || resources.has(file.policyResource);
    return !sameSwitch;
  });
  const items: GridItem[] = [
    ...entries.map((entry): GridItem => ({ kind: 'entry', entry })),
    ...visibleFiles.map((file): GridItem => ({ kind: 'file', file })),
  ];
  const filtered = rankByQuery(items, query, (item) => (
    item.kind === 'entry' ? [pluginDisplayName(item.entry.spec), item.entry.spec] : [item.file.fileName, item.file.absolutePath ?? '']
  ));
  const hasQuery = query.trim().length > 0;
  const refreshing = isLoadingRegistry || isCheckingUpdates;

  return (
    <SettingsPageLayout
      title={t('settings.page.plugins.title')}
      namedBySidebar
    >
      <SettingsCardToolbar
        search={items.length > 0 ? { value: query, onChange: setQuery, placeholder: t('settings.plugins.grid.searchPlaceholder') } : null}
        actions={(
          <>
            {runtimeUnavailable ? (
              <span className="inline-flex items-center gap-1 typography-meta text-muted-foreground">
                <Icon name="question" className="size-3.5" />
                {t('settings.plugins.status.sidebar.unavailable')}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="w-7 shrink-0 px-0 text-muted-foreground"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              aria-label={t('settings.plugins.sidebar.actions.refresh')}
              title={t('settings.plugins.sidebar.actions.refresh')}
            >
              <Icon name="refresh" className={cn('size-4', refreshing && 'animate-spin')} />
            </Button>
          </>
        )}
      />
      <p className={cn(SETTINGS_DESCRIPTION_CLASS, 'mb-4')}>{t('settings.plugins.grid.description')}</p>

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
            const name = pluginDisplayName(entry.spec);
            const switchControl = pluginSwitch(entry, name, setEntryEnabled);
            return (
              <SettingsCard
                key={entry.id}
                icon={<SettingsCardIcon name={PARSED_KIND_ICON[entry.parsedKind]} />}
                title={name}
                subtitle={name === entry.spec ? undefined : entry.spec}
                muted={switchControl.blocked}
                badges={<PluginPills target={runtimeTargets.get(entry.id) ?? null} spec={entry.spec} />}
                footer={(
                  <>
                    <span>{t(entryKindLabelKey(entry))}</span>
                    {entry.scope === 'project' ? <SettingsCardChip>{t('settings.plugins.grid.scope.project')}</SettingsCardChip> : null}
                  </>
                )}
                onOpen={entry.parsedKind === 'control' ? undefined : () => setSelected(entry.id)}
                actionsLabel={t('settings.plugins.grid.actionsAria', { name: entry.spec })}
                actions={entryActions(entry)}
                control={entry.parsedKind !== 'control' ? switchControl.control : undefined}
              />
            );
          }
          const { file } = item;
          const displayOnly = file.kind === 'package';
          const switchControl = pluginSwitch(file, file.fileName, setFileEnabled);
          return (
            <SettingsCard
              key={file.id}
              icon={<SettingsCardIcon name={displayOnly ? 'folder' : 'file-text'} />}
              title={file.fileName}
              muted={switchControl.blocked}
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
              control={switchControl.control}
            />
          );
        })}
      </div>
    </SettingsPageLayout>
  );
};
