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
}

export const GitWorkspacePanes: React.FC<GitWorkspacePanesProps> = ({ directory, changes, commit, graph }) => {
  const { t } = useI18n();
  const preferenceKey = gitRepositoryPanePreferenceKey(directory);
  const paneState = useUIStore((state) => state.gitRepositoryPaneStates[preferenceKey] ?? DEFAULT_GIT_REPOSITORY_PANE_STATE);
  const setPaneState = useUIStore((state) => state.setGitRepositoryPaneState);
  const dragStateRef = React.useRef<{ startY: number; startHeight: number } | null>(null);
  const [isGraphResizeActive, setIsGraphResizeActive] = React.useState(false);

  React.useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragStateRef.current) {
        return;
      }

      const delta = dragStateRef.current.startY - event.clientY;
      setPaneState(directory, { graphHeight: clampGitGraphPaneHeight(dragStateRef.current.startHeight + delta) });
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
          aria-orientation="horizontal"
          aria-label={t('gitView.graph.resizeAria')}
          data-git-resize-handle="true"
          className="group relative mb-2 flex h-5 w-full cursor-col-resize touch-none items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
          onPointerDown={(event) => {
            dragStateRef.current = { startY: event.clientY, startHeight: paneState.graphHeight };
            setIsGraphResizeActive(true);
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
