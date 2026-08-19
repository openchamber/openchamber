import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import {
  DEFAULT_GIT_REPOSITORY_PANE_STATE,
  gitRepositoryPanePreferenceKey,
  useUIStore,
} from '@/stores/useUIStore';
import { clampGitGraphPaneHeight } from './gitWorkspacePanesModel';

const GRAPH_HEIGHT_STEP = 24;

interface GitWorkspacePanesProps {
  directory: string;
  changes: React.ReactNode;
  commit: React.ReactNode;
  graph: React.ReactNode;
}

export const GitWorkspacePanes: React.FC<GitWorkspacePanesProps> = ({ directory, changes, commit, graph }) => {
  const { t } = useI18n();
  const preferenceKey = gitRepositoryPanePreferenceKey(directory);
  const paneState = useUIStore((state) => state.gitRepositoryPaneStates[preferenceKey] ?? DEFAULT_GIT_REPOSITORY_PANE_STATE);
  const setPaneState = useUIStore((state) => state.setGitRepositoryPaneState);
  const dragStateRef = React.useRef<{ startY: number; startHeight: number } | null>(null);

  React.useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragStateRef.current) {
        return;
      }

      const delta = dragStateRef.current.startY - event.clientY;
      setPaneState(directory, { graphHeight: clampGitGraphPaneHeight(dragStateRef.current.startHeight + delta) });
    };

    const handlePointerUp = () => {
      dragStateRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [directory, setPaneState]);

  return (
    <div id="git-workspace-panes" className="flex h-full min-h-0 flex-col gap-3">
      <section id="git-changes-pane" className="flex min-h-0 flex-1 flex-col">
        <div className="mb-2 flex items-center gap-2">
          <Button type="button" variant="ghost" size="xs" aria-expanded={!paneState.changesCollapsed} aria-controls="git-changes-pane-body" onClick={() => setPaneState(directory, { changesCollapsed: !paneState.changesCollapsed })}>
            <Icon name={paneState.changesCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className="mr-1 size-3" />
            {t('gitView.changes.title')}
          </Button>
        </div>
        {!paneState.changesCollapsed ? <div id="git-changes-pane-body" className="min-h-0 flex-1">{changes}</div> : null}
      </section>

      <section id="git-commit-pane" className="shrink-0">{commit}</section>

      <section id="git-graph-pane" className="flex min-h-0 shrink-0 flex-col">
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={t('gitView.graph.resizeAria')}
          className="mb-2 h-2 cursor-row-resize rounded bg-[var(--surface-subtle)] hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
          onPointerDown={(event) => {
            dragStateRef.current = { startY: event.clientY, startHeight: paneState.graphHeight };
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setPaneState(directory, { graphHeight: clampGitGraphPaneHeight(paneState.graphHeight + GRAPH_HEIGHT_STEP) });
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setPaneState(directory, { graphHeight: clampGitGraphPaneHeight(paneState.graphHeight - GRAPH_HEIGHT_STEP) });
            }
          }}
        />
        <div className="mb-2 flex items-center gap-2">
          <Button type="button" variant="ghost" size="xs" aria-expanded={!paneState.graphCollapsed} aria-controls="git-graph-pane-body" onClick={() => setPaneState(directory, { graphCollapsed: !paneState.graphCollapsed })}>
            <Icon name={paneState.graphCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className="mr-1 size-3" />
            {t('gitView.graph.title')}
          </Button>
        </div>
        {!paneState.graphCollapsed ? (
          <div id="git-graph-pane-body" className="min-h-0" style={{ height: paneState.graphHeight }}>
            {graph}
          </div>
        ) : null}
      </section>
    </div>
  );
};
