import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
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
  graphHeaderControls?: React.ReactNode;
}

export const GitWorkspacePanes: React.FC<GitWorkspacePanesProps> = ({ directory, changes, commit, graph, graphHeaderControls }) => {
  const { t } = useI18n();
  const preferenceKey = gitRepositoryPanePreferenceKey(directory);
  const changesCollapsed = useUIStore((state) => state.gitRepositoryPaneStates[preferenceKey]?.changesCollapsed ?? DEFAULT_GIT_REPOSITORY_PANE_STATE.changesCollapsed);
  const graphCollapsed = useUIStore((state) => state.gitGraphPaneCollapsed);
  const graphHeight = useUIStore((state) => state.gitGraphPaneHeight);
  const setPaneState = useUIStore((state) => state.setGitRepositoryPaneState);
  const setGitGraphPaneCollapsed = useUIStore((state) => state.setGitGraphPaneCollapsed);
  const setGitGraphPaneHeight = useUIStore((state) => state.setGitGraphPaneHeight);
  const dragStateRef = React.useRef<{ startY: number; startHeight: number } | null>(null);
  const [isGraphResizeActive, setIsGraphResizeActive] = React.useState(false);

  React.useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragStateRef.current) {
        return;
      }

      const delta = dragStateRef.current.startY - event.clientY;
      setGitGraphPaneHeight(clampGitGraphPaneHeight(dragStateRef.current.startHeight + delta));
    };

    const handlePointerEnd = () => {
      dragStateRef.current = null;
      setIsGraphResizeActive(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [setGitGraphPaneHeight]);

  return (
    <div id="git-workspace-panes" className="flex h-full min-h-0 flex-col gap-3">
      <section id="git-changes-pane" className="flex min-h-0 flex-1 flex-col">
        <div className="mb-2 flex items-center gap-2">
          <Button type="button" variant="ghost" size="xs" aria-expanded={!changesCollapsed} aria-controls="git-changes-pane-body" onClick={() => setPaneState(directory, { changesCollapsed: !changesCollapsed })}>
            <Icon name={changesCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className="mr-1 size-3" />
            {t('gitView.changes.title')}
          </Button>
        </div>
        {!changesCollapsed ? <div id="git-changes-pane-body" className="min-h-0 flex-1 flex flex-col">{changes}</div> : null}
      </section>

      <section id="git-commit-pane" className="shrink-0">{commit}</section>

      <section id="git-graph-pane" className="flex min-h-0 shrink-0 flex-col">
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label={t('gitView.graph.resizeAria')}
          data-git-resize-handle="true"
          className="group relative mb-2 flex h-5 w-full cursor-row-resize touch-none items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
          onPointerDown={(event) => {
            dragStateRef.current = { startY: event.clientY, startHeight: graphHeight };
            setIsGraphResizeActive(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setGitGraphPaneHeight(clampGitGraphPaneHeight(graphHeight + GRAPH_HEIGHT_STEP));
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setGitGraphPaneHeight(clampGitGraphPaneHeight(graphHeight - GRAPH_HEIGHT_STEP));
            }
          }}
        >
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--surface-subtle)] transition-colors group-hover:bg-[var(--chart-1)] group-focus-visible:bg-[var(--chart-1)]',
              isGraphResizeActive && 'bg-[var(--chart-1)]',
            )}
          />
          <span aria-hidden="true" className="relative z-10 flex items-center gap-1">
            <span
              data-git-resize-dot="true"
              className={cn(
                'size-1 rounded-full bg-[var(--surface-muted-foreground)] transition-colors group-hover:bg-[var(--chart-1)] group-focus-visible:bg-[var(--chart-1)]',
                isGraphResizeActive && 'bg-[var(--chart-1)]',
              )}
            />
            <span
              data-git-resize-dot="true"
              className={cn(
                'size-1 rounded-full bg-[var(--surface-muted-foreground)] transition-colors group-hover:bg-[var(--chart-1)] group-focus-visible:bg-[var(--chart-1)]',
                isGraphResizeActive && 'bg-[var(--chart-1)]',
              )}
            />
            <span
              data-git-resize-dot="true"
              className={cn(
                'size-1 rounded-full bg-[var(--surface-muted-foreground)] transition-colors group-hover:bg-[var(--chart-1)] group-focus-visible:bg-[var(--chart-1)]',
                isGraphResizeActive && 'bg-[var(--chart-1)]',
              )}
            />
          </span>
        </div>
        <div className="mb-2 flex items-center gap-2">
          <Button type="button" variant="ghost" size="xs" aria-expanded={!graphCollapsed} aria-controls="git-graph-pane-body" onClick={() => setGitGraphPaneCollapsed(!graphCollapsed)}>
            <Icon name={graphCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className="mr-1 size-3" />
            {t('gitView.graph.title')}
          </Button>
          {!graphCollapsed && graphHeaderControls ? <div className="ml-auto">{graphHeaderControls}</div> : null}
        </div>
        {!graphCollapsed ? (
          <div id="git-graph-pane-body" className="min-h-0" style={{ height: graphHeight }}>
            {graph}
          </div>
        ) : null}
      </section>
    </div>
  );
};
