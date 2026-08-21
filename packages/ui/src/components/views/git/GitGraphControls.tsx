import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { RuntimeAPIs } from '@/lib/api/types';
import {
  useGitHistoryQueryState,
  useGitHistoryRefsState,
  useGitStore,
} from '@/stores/useGitStore';
import {
  DEFAULT_GIT_REPOSITORY_PANE_STATE,
  gitRepositoryPanePreferenceKey,
  useUIStore,
} from '@/stores/useUIStore';
import {
  isGitGraphFilterDisabled,
  resolveGraphQuery,
} from './gitGraphPanelModel';

interface GitGraphControlsProps {
  directory: string;
  git: RuntimeAPIs['git'];
}

export const GitGraphControls: React.FC<GitGraphControlsProps> = ({ directory, git }) => {
  const { t } = useI18n();
  const preferenceKey = gitRepositoryPanePreferenceKey(directory);
  const paneState = useUIStore((state) => state.gitRepositoryPaneStates[preferenceKey] ?? DEFAULT_GIT_REPOSITORY_PANE_STATE);
  const setPaneState = useUIStore((state) => state.setGitRepositoryPaneState);
  const ensureHistoryRefs = useGitStore((state) => state.ensureHistoryRefs);
  const fetchHistoryPage = useGitStore((state) => state.fetchHistoryPage);
  const { refsError, isLoadingRefs } = useGitHistoryRefsState(directory);
  const query = React.useMemo(() => resolveGraphQuery(paneState), [paneState]);
  const queryState = useGitHistoryQueryState(directory, query);
  const areFilterControlsDisabled = React.useMemo(
    () => isGitGraphFilterDisabled({ isLoadingRefs, refsError }),
    [isLoadingRefs, refsError],
  );

  const refresh = React.useCallback(async () => {
    try {
      await ensureHistoryRefs(directory, git, { force: true });
      await fetchHistoryPage(directory, git, query);
    } catch { /* errors surfaced through store state */ }
  }, [directory, ensureHistoryRefs, fetchHistoryPage, git, query]);

  return (
    <div data-ui="git-graph-controls" className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        size="xs"
        variant={paneState.graphFilterMode === 'auto' ? 'secondary' : 'ghost'}
        onClick={() => setPaneState(directory, { graphFilterMode: 'auto', graphManualRefIds: [] })}
        disabled={areFilterControlsDisabled}
      >
        {t('quota.window.auto')}
      </Button>
      <Button
        type="button"
        size="xs"
        variant={paneState.graphFilterMode === 'all' ? 'secondary' : 'ghost'}
        onClick={() => setPaneState(directory, { graphFilterMode: 'all', graphManualRefIds: [] })}
        disabled={areFilterControlsDisabled}
      >
        {t('contextPanel.preview.console.filter.all')}
      </Button>
      <Button
        type="button"
        size="xs"
        variant={paneState.graphFilterMode === 'manual' ? 'secondary' : 'ghost'}
        onClick={() => setPaneState(directory, { graphFilterMode: 'manual' })}
        disabled={areFilterControlsDisabled}
      >
        {t('sessions.sidebar.header.projectSort.manual')}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={t('gitView.history.refresh')}
        onClick={() => void refresh()}
        disabled={isLoadingRefs || queryState?.isLoading || queryState?.isLoadingMore}
      >
        <Icon name="refresh" className="size-3" />
      </Button>
    </div>
  );
};
