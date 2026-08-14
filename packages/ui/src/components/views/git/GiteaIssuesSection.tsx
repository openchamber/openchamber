import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ForgeEntityDetailView } from '@/components/views/forge';
import { ForgeCreateIssueDialog } from '@/components/views/forge/actions';
import { buildForgeProvider } from '@/lib/forge';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore } from '@/stores/useUIStore';
import { useGiteaAuthStore } from '@/stores/useGiteaAuthStore';
import type { GiteaIssueSummary } from '@/lib/api/types';
import type { ForgeIssue } from '@/lib/forge';
import { useI18n } from '@/lib/i18n';

const issueLabelBadgeClass =
  'inline-flex items-center rounded border border-border/60 bg-surface-elevated px-1.5 py-px typography-micro text-foreground';

/**
 * Open Gitea issues for the context panel's PR view. The list is fetched
 * lazily (the parent only mounts this component while the Issues tab is
 * active); selecting a row mounts the shared `ForgeEntityDetailView` for the
 * issue detail. Issue creation is supported here via the "new issue" button
 * and `ForgeCreateIssueDialog`; the detail view also offers edit, close/reopen,
 * comments, and metadata editing through the Gitea provider's write methods.
 */
export const GiteaIssuesSection: React.FC<{ directory: string }> = ({ directory }) => {
  const { t } = useI18n();
  const { gitea } = useRuntimeAPIs();
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const giteaAuthStatus = useGiteaAuthStore((state) => state.status);
  const giteaAuthChecked = useGiteaAuthStore((state) => state.hasChecked);

  // ---- Open issues list ----------------------------------------------------

  const [issues, setIssues] = React.useState<GiteaIssueSummary[]>([]);
  const [listPage, setListPage] = React.useState(1);
  const [listHasMore, setListHasMore] = React.useState(false);
  const [listLoading, setListLoading] = React.useState(false);
  const [listLoadingMore, setListLoadingMore] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);
  const [listNotConnected, setListNotConnected] = React.useState(false);
  const [retryToken, setRetryToken] = React.useState(0);

  // ---- Selected issue detail ------------------------------------------------

  const [selectedNumber, setSelectedNumber] = React.useState<number | null>(null);
  const [selectedUrl, setSelectedUrl] = React.useState<string | null>(null);

  const issueProvider = React.useMemo(() => (gitea ? buildForgeProvider('gitea', { gitea }) : null), [gitea]);

  const [createOpen, setCreateOpen] = React.useState(false);

  const retry = React.useCallback(() => setRetryToken((value) => value + 1), []);

  const openGiteaSettings = React.useCallback(() => {
    setSettingsPage('git');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage]);

  const handleIssueCreated = React.useCallback((issue: ForgeIssue) => {
    setSelectedNumber(issue.number);
    setSelectedUrl(issue.url ?? null);
    setRetryToken((value) => value + 1);
  }, []);

  // The parent PR view already gates on connection, but the auth store is the
  // authoritative signal when the list API reports connected without having
  // checked the account yet.
  const authNotConnected = giteaAuthChecked && giteaAuthStatus?.connected === false;

  // A different repository invalidates the previously loaded list and detail so
  // a stale repository's issues never leak into the new one.
  React.useEffect(() => {
    setIssues([]);
    setListPage(1);
    setListHasMore(false);
    setListLoading(false);
    setListLoadingMore(false);
    setListError(null);
    setListNotConnected(false);
    setSelectedNumber(null);
    setSelectedUrl(null);
  }, [directory]);

  React.useEffect(() => {
    if (!gitea?.issuesList) {
      return;
    }
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    setListNotConnected(false);
    void gitea
      .issuesList(directory, { page: 1 })
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.connected === false) {
          setListNotConnected(true);
          return;
        }
        setIssues(result.issues ?? []);
        setListPage(result.page ?? 1);
        setListHasMore(Boolean(result.hasMore));
      })
      .catch((error) => {
        if (!cancelled) {
          setListError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setListLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [directory, gitea, retryToken]);

  const loadMore = React.useCallback(async () => {
    if (!gitea?.issuesList || listLoadingMore || listLoading || !listHasMore) {
      return;
    }
    setListLoadingMore(true);
    try {
      const next = await gitea.issuesList(directory, { page: listPage + 1 });
      if (next.connected === false) {
        setListNotConnected(true);
        return;
      }
      setIssues((previous) => [...previous, ...(next.issues ?? [])]);
      setListPage(next.page ?? listPage + 1);
      setListHasMore(Boolean(next.hasMore));
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setListLoadingMore(false);
    }
  }, [directory, gitea, listHasMore, listLoading, listLoadingMore, listPage]);

  const selectIssue = React.useCallback((item: GiteaIssueSummary) => {
    setSelectedNumber(item.number);
    setSelectedUrl(item.url);
  }, []);

  const backToIssues = React.useCallback(() => {
    setSelectedNumber(null);
    setSelectedUrl(null);
  }, []);

  if (selectedNumber !== null) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={backToIssues}>
            <Icon name="arrow-left" className="size-4" />
            {t('contextPanel.giteaPr.issues.detail.back')}
          </Button>
          {selectedUrl ? (
            <Button variant="outline" size="sm" asChild className="h-7 w-fit gap-1.5 px-2">
              <a href={selectedUrl} target="_blank" rel="noopener noreferrer">
                <Icon name="external-link" className="size-4" />
                {t('contextPanel.giteaPr.openInGitea')}
              </a>
            </Button>
          ) : null}
        </div>

        {issueProvider ? (
          <ForgeEntityDetailView
            provider={issueProvider}
            directory={directory}
            number={selectedNumber}
            options={{ kind: 'issue' }}
            onOpenSettings={openGiteaSettings}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="typography-ui-header font-semibold text-foreground">{t('contextPanel.giteaPr.issues.listSectionTitle')}</div>
        {issueProvider?.createIssue ? (
          <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2" onClick={() => setCreateOpen(true)}>
            <Icon name="add" className="size-4" />
            {t('forge.actions.newIssue')}
          </Button>
        ) : null}
      </div>

      {!gitea?.issuesList ? (
        <div className="typography-micro text-muted-foreground">{t('contextPanel.giteaPr.issues.empty')}</div>
      ) : listNotConnected || authNotConnected ? (
        <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
          <Icon name="git-pull-request" className="h-12 w-12 text-muted-foreground/50" />
          <div className="typography-ui-header text-foreground">{t('contextPanel.giteaPr.error.notConnected')}</div>
          <Button variant="outline" size="sm" onClick={openGiteaSettings} className="w-fit">
            {t('contextPanel.giteaPr.actions.openSettings')}
          </Button>
        </div>
      ) : listLoading ? (
        <div className="flex items-center gap-2 typography-micro text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />
          {t('contextPanel.giteaPr.loading')}
        </div>
      ) : listError ? (
        <div className="flex flex-col gap-2">
          <div className="typography-ui-label text-foreground">{t('contextPanel.giteaPr.issues.error.loadFailed')}</div>
          <div className="typography-micro text-muted-foreground break-words">{listError}</div>
          <Button variant="outline" size="sm" onClick={retry} className="w-fit">
            {t('contextPanel.preview.actions.retry')}
          </Button>
        </div>
      ) : issues.length === 0 ? (
        <div className="typography-micro text-muted-foreground">{t('contextPanel.giteaPr.issues.empty')}</div>
      ) : (
        <div className="flex min-w-0 flex-col">
          {issues.map((item) => (
            <div
              key={item.number}
              className="group flex cursor-pointer items-center gap-2 rounded py-1.5 transition-colors hover:bg-interactive-hover/30"
              onClick={() => selectIssue(item)}
            >
              <div className="min-w-0 flex-1">
                <p className="typography-small truncate text-foreground">
                  <span className="mr-1 text-muted-foreground">#{item.number}</span>
                  {item.title}
                </p>
                {item.labels.length > 0 ? (
                  <p className="mt-1 flex min-w-0 flex-wrap gap-1">
                    {item.labels.map((label) => (
                      <span key={label} className={issueLabelBadgeClass}>{label}</span>
                    ))}
                  </p>
                ) : null}
              </div>
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                aria-label={t('contextPanel.giteaPr.openInGitea')}
                className="hidden size-5 flex-shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground group-hover:flex"
              >
                <Icon name="external-link" className="size-4" />
              </a>
            </div>
          ))}

          {listHasMore ? (
            <div className="flex justify-center py-2">
              <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={listLoadingMore}>
                {listLoadingMore ? (
                  <Icon name="loader-4" className="size-4 animate-spin" />
                ) : null}
                {t('contextPanel.giteaPr.loadMore')}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {issueProvider?.createIssue ? (
        <ForgeCreateIssueDialog
          provider={issueProvider}
          directory={directory}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={handleIssueCreated}
        />
      ) : null}
    </div>
  );
};
