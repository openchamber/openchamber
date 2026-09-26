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
  type SettingsCardTone,
} from '@/components/sections/shared/SettingsCards';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useI18n } from '@/lib/i18n';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn } from '@/lib/utils';
import { selectMcpServersForDirectory, useMcpConfigStore, type McpDraft } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import type { McpServerStatus } from '@/lib/opencode/model';
import { MCP_DRAFT_OAUTH_UNSET } from './mcpDraft';

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

const StatusPill: React.FC<{ status: McpServerStatus['status']['status'] | undefined; enabled: boolean }> = ({ status, enabled }) => {
  const { t } = useI18n();
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
export const McpGrid: React.FC = () => {
  const { t } = useI18n();
  const settingsDirectory = useSettingsDirectory();
  const { setSelectedMcp, setMcpDraft, loadMcpConfigs, deleteMcp } = useMcpConfigStore(useShallow((state) => ({
    setSelectedMcp: state.setSelectedMcp,
    setMcpDraft: state.setMcpDraft,
    loadMcpConfigs: state.loadMcpConfigs,
    deleteMcp: state.deleteMcp,
  })));
  const [deleteTarget, setDeleteTarget] = React.useState<string | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const servers = useMcpConfigStore((state) => selectMcpServersForDirectory(state, settingsDirectory));
  const mcpStatus = useMcpStore((state) => state.getStatusForDirectory(settingsDirectory));
  const refreshStatus = useMcpStore((state) => state.refresh);
  const getErrorForDirectory = useMcpStore((state) => state.getErrorForDirectory);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    void loadMcpConfigs({ directory: settingsDirectory });
  }, [loadMcpConfigs, settingsDirectory]);

  const handleRefresh = () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    // Keep the spinner up long enough to read as a refresh.
    const minSpin = new Promise((resolve) => setTimeout(resolve, 500));
    void Promise.all([refreshStatus({ directory: settingsDirectory, silent: true }), minSpin])
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
    const name = deleteTarget;
    setIsDeleting(true);
    const result = await deleteMcp(name, settingsDirectory);
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

  const filtered = rankByQuery([...servers], query, (server) => [
    server.name,
    server.type === 'local' ? server.command?.join(' ') ?? '' : server.url ?? '',
  ]);
  const hasQuery = query.trim().length > 0;

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
      {servers.length > 0 ? (
        <SettingsCardSearch value={query} onChange={setQuery} placeholder={t('settings.mcp.grid.searchPlaceholder')} />
      ) : null}

      {servers.length === 0 ? (
        <p className="py-6 typography-meta text-muted-foreground">{t('settings.mcp.grid.empty')}</p>
      ) : filtered.length === 0 ? (
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
        {filtered.map((server) => {
          const enabled = server.disabled !== true;
          const target = server.type === 'local' ? server.command?.join(' ') : server.url;
          return (
            <SettingsCard
              key={server.name}
              icon={<SettingsCardIcon name={server.type === 'local' ? 'server' : 'global'} />}
              title={server.name}
              subtitle={target || undefined}
              badges={<StatusPill status={mcpStatus[server.name]?.status.status} enabled={enabled} />}
              muted={!enabled}
              footer={(
                <>
                  <span>
                    {server.type === 'local'
                      ? t('settings.mcp.sidebar.serverType.localTitle')
                      : t('settings.mcp.sidebar.serverType.remoteTitle')}
                  </span>
                  {server.scope === 'project' ? <SettingsCardChip>{t('settings.mcp.grid.scope.project')}</SettingsCardChip> : null}
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
                onSelect: () => setDeleteTarget(server.name),
              }]}
            />
          );
        })}
      </div>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !isDeleting) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.mcp.page.deleteDialog.title', { name: deleteTarget ?? '' })}</DialogTitle>
            <DialogDescription>
              {t('settings.mcp.page.deleteDialog.descriptionPrefix')}{' '}
              <code className="text-foreground">opencode.json</code>.
              {' '}
              {t('settings.mcp.page.deleteDialog.descriptionSuffix')}
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
