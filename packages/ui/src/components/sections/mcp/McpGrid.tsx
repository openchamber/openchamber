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
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsAddCard,
  SettingsCard,
  SettingsCardChip,
  SettingsCardIcon,
  SettingsCardPill,
  SettingsCardSearch,
  type SettingsCardAction,
  type SettingsCardTone,
} from '@/components/sections/shared/SettingsCards';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn } from '@/lib/utils';
import { hasLoadedMcpConfigsForDirectory, selectMcpServersForDirectory, useMcpConfigStore, type McpDraft } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import type { McpServerStatus } from '@/lib/opencode/model';
import { useIntegrationPolicyBlock } from '@/components/sections/shared/useIntegrationPolicyBlock';
import { MCP_DRAFT_OAUTH_UNSET } from './mcpDraft';
import { MCP_SCOPE_LABEL_KEYS } from './mcpScope';
import { deleteProtectedConnection, PROTECTED_SERVICE_PROBLEM_KEYS, ProtectedMcpRequestError, type useProtectedMcp, type ProtectedConnection, type ProtectedSelectionRequest } from './protectedMcp';
import { hasProtectedSelections, orphanActions, orphanedSelections, PROTECTED_USE_LABEL_KEYS, protectedCards, selectionActions } from './protectedMcpCards';

const FINDING_KEYS = new Map<string, I18nKey>([
  ['engine_is_root', 'settings.mcp.protected.finding.engine_is_root'],
  ['owned_by_engine', 'settings.mcp.protected.finding.owned_by_engine'],
  ['untrusted_owner', 'settings.mcp.protected.finding.untrusted_owner'],
  ['writable_by_others', 'settings.mcp.protected.finding.writable_by_others'],
  ['writable_by_group', 'settings.mcp.protected.finding.writable_by_group'],
  ['acl_writable_by_engine', 'settings.mcp.protected.finding.acl_writable_by_engine'],
  ['acl_unreadable', 'settings.mcp.protected.finding.acl_unreadable'],
  ['acl_not_inspected', 'settings.mcp.protected.finding.acl_not_inspected'],
  ['path_missing', 'settings.mcp.protected.finding.path_missing'],
  ['private_directory_open', 'settings.mcp.protected.finding.private_directory_open'],
  ['socket_not_inspected', 'settings.mcp.protected.finding.socket_not_inspected'],
  ['root_equivalent_socket', 'settings.mcp.protected.finding.root_equivalent_socket'],
  ['root_equivalent_group', 'settings.mcp.protected.finding.root_equivalent_group'],
  ['engine_can_escalate', 'settings.mcp.protected.finding.engine_can_escalate'],
  ['engine_account_can_administer', 'settings.mcp.protected.finding.engine_account_can_administer'],
  ['container_group_member', 'settings.mcp.protected.finding.container_group_member'],
  ['groups_unreadable', 'settings.mcp.protected.finding.groups_unreadable'],
  ['engine_unit_unreadable', 'settings.mcp.protected.finding.engine_unit_unreadable'],
  ['not_checked', 'settings.mcp.protected.finding.not_checked'],
  ['preflight_failed', 'settings.mcp.protected.finding.preflight_failed'],
]);

const ProtectedServiceNotice: React.FC<{ state: ReturnType<typeof useProtectedMcp>['state'] }> = ({ state }) => {
  const { t } = useI18n();
  if (state.kind === 'loading' || state.kind === 'unsupported') return null;
  if (state.kind === 'failed') return <p role="status" className={cn(SETTINGS_HELPER_CLASS, 'mb-4')}>{t('settings.mcp.protected.loadFailed')}</p>;
  const { status } = state;
  const { service } = status;
  if (!status.host.supported || service.state === 'unsupported_platform') return null;
  if (service.state === 'not_installed' && !hasProtectedSelections(status) && !status.selectionsError) return null;
  const enforcement = service.state === 'available' ? service.status.enforcement : null;
  if (service.state === 'available' && enforcement?.status === 'protected' && !status.selectionsError) return null;
  return (
    <div role="status" className={cn(SETTINGS_HELPER_CLASS, 'mb-4 space-y-2')}>
      {service.state !== 'available' && (service.state !== 'not_installed' || hasProtectedSelections(status)) ? <p>{t(PROTECTED_SERVICE_PROBLEM_KEYS[service.state])}</p> : null}
      {status.selectionsError ? <p>{t('settings.mcp.protected.selectionsUnreadable')}</p> : null}
      {enforcement && enforcement.status !== 'protected' ? (
        <div className="space-y-1">
          <p>{t(enforcement.status === 'unverified' ? 'settings.mcp.protected.notice.unverifiedLead' : 'settings.mcp.protected.notice.unprotectedLead')}</p>
          <ul className="space-y-1">
            {enforcement.findings.map((finding, index) => {
              const key = FINDING_KEYS.get(finding.code) ?? 'settings.mcp.protected.finding.other';
              // Keep the complete translated sentence while styling only its subject.
              const [before, after] = t(key, { code: finding.code }).split('{subject}');
              return <li key={`${finding.code}:${finding.subject ?? ''}:${index}`} className="break-words">{before}{after !== undefined ? <><code dir="ltr" className="font-mono break-all">{finding.subject}</code>{after}</> : null}</li>;
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
};

const nextServerName = (existing: readonly { name: string }[]): string => {
  const baseName = 'new-mcp-server';
  let name = baseName;
  let counter = 1;
  while (existing.some((server) => server.name === name)) {
    name = `${baseName}-${counter}`;
    counter += 1;
  }
  return name;
};

const StatusPill: React.FC<{
  status: McpServerStatus['status']['status'] | undefined;
  enabled: boolean;
  blocked: boolean;
}> = ({ status, enabled, blocked }) => {
  const { t } = useI18n();
  // OpenCode never loads a blocked server, so it has no status of its own to show.
  if (blocked) return <SettingsCardPill tone="warning">{t('settings.mcp.grid.status.blockedByPolicy')}</SettingsCardPill>;
  if (!enabled) return <SettingsCardPill tone="neutral">{t('settings.mcp.grid.status.disabled')}</SettingsCardPill>;
  const pill: { tone: SettingsCardTone; label: string } | null = status === 'connected'
    ? { tone: 'success', label: t('settings.mcp.page.status.label.connected') }
    : status === 'failed'
      ? { tone: 'error', label: t('settings.mcp.page.status.label.failed') }
      : status === 'needs_auth'
        ? { tone: 'warning', label: t('settings.mcp.page.status.label.needsAuth') }
        : status === 'pending'
          ? { tone: 'neutral', label: t('settings.mcp.grid.status.pending') }
          : null;
  return pill ? <SettingsCardPill tone={pill.tone}>{pill.label}</SettingsCardPill> : null;
};

/** Browse view of the MCP page: one card per configured server with its live status. */
export const McpGrid: React.FC<{ readonly protectedMcp: ReturnType<typeof useProtectedMcp> }> = ({ protectedMcp }) => {
  const { t } = useI18n();
  const settingsDirectory = useSettingsDirectory();
  const { setSelectedMcp, setSelectedProtected, setMcpDraft, loadMcpConfigs, deleteMcp } = useMcpConfigStore(useShallow((state) => ({
    setSelectedMcp: state.setSelectedMcp,
    setSelectedProtected: state.setSelectedProtected,
    setMcpDraft: state.setMcpDraft,
    loadMcpConfigs: state.loadMcpConfigs,
    deleteMcp: state.deleteMcp,
  })));
  const [deleteTarget, setDeleteTarget] = React.useState<Pick<McpDraft, 'name' | 'scope'> | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const servers = useMcpConfigStore((state) => selectMcpServersForDirectory(state, settingsDirectory));
  const mcpStatus = useMcpStore((state) => state.getStatusForDirectory(settingsDirectory));
  // Runtime-only rows wait for the config catalog: before it is read, every
  // server the runtime reports would read as runtime-only, and a configured
  // server would flash as one while its config entry was still loading.
  const configsLoaded = useMcpConfigStore((state) => hasLoadedMcpConfigsForDirectory(state, settingsDirectory));
  const isBlocked = useIntegrationPolicyBlock(settingsDirectory);
  const refreshStatus = useMcpStore((state) => state.refresh);
  const getErrorForDirectory = useMcpStore((state) => state.getErrorForDirectory);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const { state: protectedState, change: changeProtected, reload: reloadProtected } = protectedMcp;
  const [busySelection, setBusySelection] = React.useState<string | null>(null);
  const [protectedDeleteTarget, setProtectedDeleteTarget] = React.useState<ProtectedConnection | null>(null);
  const [isDeletingProtected, setIsDeletingProtected] = React.useState(false);

  React.useEffect(() => {
    void loadMcpConfigs({ directory: settingsDirectory });
  }, [loadMcpConfigs, settingsDirectory]);

  const handleRefresh = () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    // Keep the spinner up long enough to read as a refresh.
    const minSpin = new Promise((resolve) => setTimeout(resolve, 500));
    void Promise.all([refreshStatus({ directory: settingsDirectory, silent: true }), reloadProtected(), minSpin])
      .then(() => {
        const error = getErrorForDirectory(settingsDirectory);
        if (error) toast.error(error);
      })
      .finally(() => setIsRefreshing(false));
  };

  const handleCreate = () => {
    const name = nextServerName(servers);
    const draft: McpDraft = {
      name,
      scope: 'user',
      type: 'local',
      command: [],
      url: '',
      environment: [],
      headers: [],
      ...MCP_DRAFT_OAUTH_UNSET,
      oauthAuthServerMetadataUrl: '',
      protocol: 'legacy',
      timeoutStartup: '',
      timeoutCatalog: '',
      timeoutExecution: '',
      codemode: 'default',
      disabled: false,
    };
    setMcpDraft(draft);
    setSelectedMcp(name);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const { name, scope } = deleteTarget;
    setIsDeleting(true);
    const result = await deleteMcp(name, settingsDirectory, scope);
    if (result.ok) {
      if (result.reloadFailed) {
        toast.warning(result.message || t('settings.mcp.page.toast.serverDeletedReloadFailed', { name }), {
          description: result.warning || t('settings.mcp.page.toast.refreshListIfStale'),
        });
      } else {
        toast.success(result.message || t('settings.mcp.page.toast.serverDeleted', { name }));
      }
      setDeleteTarget(null);
    } else {
      toast.error(t('settings.mcp.page.toast.deleteFailed'));
    }
    setIsDeleting(false);
  };

  const applySelection = async (name: string, request: ProtectedSelectionRequest) => {
    setBusySelection(name);
    try {
      await changeProtected(name, request);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      toast.error(error instanceof ProtectedMcpRequestError && error.code === 'name_in_use'
        ? t('settings.mcp.protected.nameInUse', { name })
        : t('settings.mcp.protected.saveFailed'));
    } finally {
      setBusySelection(null);
    }
  };
  const toCardActions = (actions: ReturnType<typeof selectionActions>): SettingsCardAction[] => actions.map((action) => ({
    label: t(action.labelKey), icon: action.icon, destructive: action.destructive,
    onSelect: () => void applySelection(action.name, action.request),
  }));
  const handleProtectedDelete = async () => {
    if (!protectedDeleteTarget || isDeletingProtected) return;
    const { id, name, revision } = protectedDeleteTarget;
    setIsDeletingProtected(true);
    try {
      const notUpdated = await deleteProtectedConnection(id, { expectedRevision: revision });
      setProtectedDeleteTarget(null);
      if (notUpdated.length > 0) toast.warning(t('settings.mcp.protected.delete.selectionsNotUpdated'));
      else toast.success(t('settings.mcp.page.toast.serverDeleted', { name }));
      await reloadProtected();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setProtectedDeleteTarget(null);
      toast.error(t('settings.mcp.page.toast.deleteFailed'));
      await reloadProtected();
    } finally {
      setIsDeletingProtected(false);
    }
  };

  const protectedStatus = protectedState.kind === 'ready' && protectedState.status.host.supported && protectedState.status.service.state !== 'unsupported_platform'
    ? protectedState.status : null;
  const connections = protectedStatus?.service.state === 'available' ? protectedStatus.service.status.connections : [];
  const cards = protectedStatus ? protectedCards(protectedStatus, connections) : [];
  const orphans = protectedStatus ? orphanedSelections(protectedStatus, connections) : [];

  // Runtime-only servers, such as a signed-in workspace's Console MCP, are
  // read-only. Configured servers, protected aliases and orphaned selections
  // already have their own cards, so wait for protected discovery as well.
  const representedNames = new Set([...servers, ...cards, ...orphans].map((server) => server.name));
  const runtimeServers = configsLoaded && protectedState.kind !== 'loading'
    ? Object.values(mcpStatus).filter((server) => !representedNames.has(server.name))
    : [];
  const rows = [
    ...servers.map((server) => ({ kind: 'config' as const, server })),
    ...runtimeServers.map((server) => ({ kind: 'runtime' as const, server })),
  ];
  const filtered = rankByQuery(rows, query, (row) => [
    row.server.name,
    row.kind === 'config'
      ? row.server.type === 'local' ? row.server.command?.join(' ') ?? '' : row.server.url ?? ''
      : '',
  ]);
  const hasQuery = query.trim().length > 0;
  const filteredProtected = rankByQuery(cards, query, ({ name, connection }) => [name, connection.name, connection.target.label]);
  const filteredOrphans = rankByQuery(orphans, query, ({ name }) => [name]);
  const cardCount = rows.length + cards.length + orphans.length;
  const matchCount = filtered.length + filteredProtected.length + filteredOrphans.length;

  return (
    <SettingsPageLayout
      title={t('settings.page.mcp.title')}
      description={t('settings.mcp.grid.description')}
      headerEnd={(
        <div className="flex w-full items-center gap-2 @xl:w-auto">
          <SettingsProjectSelector className="min-w-0 flex-1 @xl:w-56 @xl:flex-none" />
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted-foreground"
            disabled={isRefreshing}
            onClick={handleRefresh}
            aria-label={t('settings.mcp.sidebar.actions.refreshStatusAria')}
            title={t('settings.mcp.sidebar.actions.refreshStatusTitle')}
          >
            <Icon name="refresh" className={cn('size-4', isRefreshing && 'animate-spin')} />
          </Button>
        </div>
      )}
    >
      <ProtectedServiceNotice state={protectedState} />

      {cardCount > 0 ? (
        <SettingsCardSearch value={query} onChange={setQuery} placeholder={t('settings.mcp.grid.searchPlaceholder')} />
      ) : null}

      {cardCount === 0 ? (
        <p className="py-6 typography-meta text-muted-foreground">{t('settings.mcp.grid.empty')}</p>
      ) : matchCount === 0 ? (
        <p className="py-6 typography-meta text-muted-foreground">{t('settings.mcp.grid.noMatches', { query: query.trim() })}</p>
      ) : null}

      <div className={SETTINGS_CARD_GRID_CLASS}>
        {hasQuery ? null : (
          <SettingsAddCard
            label={t('settings.mcp.sidebar.actions.addServerTitle')}
            hint={t('settings.mcp.grid.addHint')}
            onClick={handleCreate}
            settingsItem="mcp.create"
          />
        )}
        {filtered.map((row) => {
          if (row.kind === 'runtime') {
            const blocked = isBlocked(`mcp:${row.server.name}`);
            // No config entry backs this server, so it opens nothing and offers
            // no delete: the row is what the runtime reports, read-only.
            return (
              <SettingsCard
                key={row.server.name}
                icon={<SettingsCardIcon name="server" />}
                title={row.server.name}
                badges={(
                  <StatusPill
                    status={row.server.status.status}
                    enabled={row.server.status.status !== 'disabled'}
                    blocked={blocked}
                  />
                )}
                muted={row.server.status.status === 'disabled' || blocked}
                footer={<SettingsCardChip>{t('settings.mcp.grid.runtimeProvided')}</SettingsCardChip>}
              />
            );
          }
          const server = row.server;
          const enabled = server.disabled !== true;
          const blocked = isBlocked(`mcp:${server.name}`);
          const target = server.type === 'local' ? server.command?.join(' ') : server.url;
          return (
            <SettingsCard
              key={server.name}
              icon={<SettingsCardIcon name={server.type === 'local' ? 'server' : 'global'} />}
              title={server.name}
              subtitle={target || undefined}
              badges={(
                <StatusPill status={mcpStatus[server.name]?.status.status} enabled={enabled} blocked={blocked} />
              )}
              muted={!enabled || blocked}
              footer={(
                <>
                  <span className="min-w-0 truncate">
                    {server.type === 'local'
                      ? t('settings.mcp.sidebar.serverType.localTitle')
                      : t('settings.mcp.sidebar.serverType.remoteTitle')}
                  </span>
                  <SettingsCardChip>{t(MCP_SCOPE_LABEL_KEYS[server.scope ?? 'user'])}</SettingsCardChip>
                </>
              )}
              onOpen={() => {
                setMcpDraft(null);
                setSelectedMcp(server.name);
              }}
              actionsLabel={t('settings.mcp.grid.actionsAria', { name: server.name })}
              actions={[{
                label: t('settings.common.actions.delete'),
                icon: 'delete-bin',
                destructive: true,
                onSelect: () => setDeleteTarget({ name: server.name, scope: server.scope ?? 'user' }),
              }]}
            />
          );
        })}
        {filteredProtected.map((card) => {
          const { connection, name, use } = card;
          const selection = protectedStatus?.selections?.effective[name];
          const effective = selection?.connection === connection.id && !selection.disabled;
          const busy = busySelection === name || (isDeletingProtected && protectedDeleteTarget?.id === connection.id);
          const badge = !connection.enabled
            ? <SettingsCardPill tone="neutral">{t('settings.mcp.grid.status.disabled')}</SettingsCardPill>
            : connection.credential === 'missing'
              ? <SettingsCardPill tone="warning">{t('settings.mcp.protected.credential.missing')}</SettingsCardPill>
              : connection.credential === 'authorization_required'
                ? <SettingsCardPill tone="warning">{t('settings.mcp.protected.credential.authorizationRequired')}</SettingsCardPill>
                : effective
                  ? <StatusPill status={mcpStatus[name]?.status.status} enabled blocked={isBlocked(`mcp:${name}`)} />
                  : <SettingsCardPill tone="success">{t('settings.mcp.protected.credential.ready')}</SettingsCardPill>;
          return (
            <SettingsCard
              key={`${connection.id}:${name}`}
              icon={<SettingsCardIcon name={connection.transport === 'stdio' ? 'server' : 'global'} />}
              title={name}
              subtitle={name === connection.name ? connection.target.label : `${connection.name} · ${connection.target.label}`}
              badges={badge}
              muted={use === 'unused' || use === 'off-here' || busy}
              footer={<><Icon name="lock" className="size-3.5 shrink-0" aria-hidden /><span className="sr-only">{t('settings.mcp.page.scope.protected')}</span><SettingsCardChip>{t(PROTECTED_USE_LABEL_KEYS[use])}</SettingsCardChip></>}
              onOpen={busy ? undefined : () => { setMcpDraft(null); setSelectedProtected(connection.id); }}
              actions={busySelection !== null || isDeletingProtected ? [] : [...toCardActions(selectionActions(card, settingsDirectory)), {
                label: t('settings.mcp.protected.action.delete'), icon: 'delete-bin', destructive: true,
                onSelect: () => setProtectedDeleteTarget(connection),
              }]}
              actionsLabel={t('settings.mcp.grid.actionsAria', { name })}
            />
          );
        })}
        {filteredOrphans.map((orphan) => (
          <SettingsCard
            key={`missing-${orphan.name}`}
            icon={<SettingsCardIcon name="error-warning" />}
            title={orphan.name}
            badges={<SettingsCardPill tone="error">{t('settings.mcp.protected.unavailable')}</SettingsCardPill>}
            muted={busySelection === orphan.name}
            footer={<SettingsCardChip>{t(PROTECTED_USE_LABEL_KEYS[orphan.use])}</SettingsCardChip>}
            actions={busySelection !== null || isDeletingProtected ? [] : toCardActions(orphanActions(orphan))}
            actionsLabel={t('settings.mcp.grid.actionsAria', { name: orphan.name })}
          />
        ))}
      </div>

      <Dialog open={protectedDeleteTarget !== null} onOpenChange={(open) => { if (!open && !isDeletingProtected) setProtectedDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.mcp.protected.delete.title', { name: protectedDeleteTarget?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('settings.mcp.protected.delete.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={isDeletingProtected} onClick={() => setProtectedDeleteTarget(null)}>{t('settings.common.actions.cancel')}</Button>
            <Button variant="destructive" size="sm" disabled={isDeletingProtected} onClick={() => void handleProtectedDelete()}>{t('settings.common.actions.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !isDeleting) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.mcp.page.deleteDialog.title', { name: deleteTarget?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {deleteTarget?.scope === 'local' ? t('settings.mcp.page.deleteDialog.localDescription') : <>
                {t('settings.mcp.page.deleteDialog.descriptionPrefix')}{' '}
                <code className="text-foreground">opencode.json</code>.
                {' '}
                {t('settings.mcp.page.deleteDialog.descriptionSuffix')}
              </>}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)} disabled={isDeleting}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void handleDelete()} disabled={isDeleting}>
              {isDeleting ? t('settings.mcp.page.actions.deleting') : t('settings.common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPageLayout>
  );
};
