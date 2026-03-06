import React from 'react';
import type { BoardCard } from '@/types/kanban';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useKanbanStore } from '@/stores/useKanbanStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { KanbanCard } from '@/components/kanban/KanbanCard';
import { RiLayoutGridLine } from '@remixicon/react';

export const BoardSidebarView: React.FC = () => {
  const { currentTheme } = useThemeSystem();
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const activeDirectory = activeProject?.path?.trim() ?? null;
  const projectId = activeProject?.id ?? null;

  const board = useKanbanStore(
    React.useCallback(
      (state) => (projectId ? (state.boards.get(projectId) ?? null) : null),
      [projectId],
    ),
  );
  const hydrateProjectBoard = useKanbanStore((state) => state.hydrateProjectBoard);
  const isLoading = useKanbanStore(
    React.useCallback(
      (state) => (projectId ? state.isLoadingByProject.get(projectId) ?? false : false),
      [projectId],
    ),
  );
  const error = useKanbanStore(
    React.useCallback(
      (state) => (projectId ? state.errorByProject.get(projectId) ?? null : null),
      [projectId],
    ),
  );

  const openContextBoard = useUIStore((state) => state.openContextBoard);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);

  React.useEffect(() => {
    if (!projectId || board) {
      return;
    }
    if (activeDirectory) {
      void hydrateProjectBoard(projectId, activeDirectory).catch(() => undefined);
    }
  }, [board, hydrateProjectBoard, projectId, activeDirectory]);

  const orderedColumns = React.useMemo(() => {
    if (!board) return [];
    return [...board.columns].sort((a, b) => a.order - b.order);
  }, [board]);

  const columnCardsMap = React.useMemo(() => {
    if (!board) return new Map<string, BoardCard[]>();
    const map = new Map<string, BoardCard[]>();
    for (const column of board.columns) {
      const cards = board.cards
        .filter((card) => card.columnId === column.id)
        .sort((a, b) => a.order - b.order);
      map.set(column.id, cards);
    }
    return map;
  }, [board]);

  const handleOpenBoard = React.useCallback(() => {
    if (!activeDirectory) return;
    openContextBoard(activeDirectory);
    setActiveMainTab('chat');
  }, [activeDirectory, openContextBoard, setActiveMainTab]);

  if (!activeProject || !activeDirectory) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 py-12 text-center">
        <div
          className="rounded-full p-3"
          style={{ backgroundColor: currentTheme.colors.surface.elevated }}
        >
          <RiLayoutGridLine
            className="h-6 w-6"
            style={{ color: currentTheme.colors.surface.mutedForeground }}
          />
        </div>
        <div>
          <h3
            className="typography-ui-header font-medium"
            style={{ color: currentTheme.colors.surface.foreground }}
          >
            No Active Project
          </h3>
          <p
            className="mt-1 typography-ui-label"
            style={{ color: currentTheme.colors.surface.mutedForeground }}
          >
            Open a directory to view its board
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
        <p
          className="typography-ui-label"
          style={{ color: currentTheme.colors.surface.mutedForeground }}
        >
          Loading board...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
        <p
          className="typography-ui-label"
          style={{ color: currentTheme.colors.status.error }}
        >
          {error}
        </p>
      </div>
    );
  }

  const totalCards = board ? board.cards.length : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: `rgb(var(--surface-subtle))` }}>
        <div
          className="typography-ui-label font-medium"
          style={{ color: currentTheme.colors.surface.foreground }}
        >
          Board
        </div>
        <div className="flex items-center gap-1">
          {totalCards > 0 && (
            <span
              className="typography-micro"
              style={{ color: currentTheme.colors.surface.mutedForeground }}
            >
              {totalCards} card{totalCards !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {orderedColumns.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center">
            <p
              className="typography-ui-label"
              style={{ color: currentTheme.colors.surface.mutedForeground }}
            >
              No columns yet
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {orderedColumns.map((column) => {
              const cards = columnCardsMap.get(column.id) ?? [];
              return (
                <div key={column.id}>
                  <div
                    className="mb-1.5 px-1 typography-micro font-medium"
                    style={{ color: currentTheme.colors.surface.mutedForeground }}
                  >
                    {column.name}
                    {cards.length > 0 && (
                      <span
                        className="ml-1.5 opacity-60"
                        style={{ color: currentTheme.colors.surface.mutedForeground }}
                      >
                        {cards.length}
                      </span>
                    )}
                  </div>
                  {cards.length === 0 ? (
                    <div
                      className="rounded border border-dashed px-2 py-1.5 typography-micro text-center"
                      style={{
                        borderColor: `rgb(var(--interactive-border))`,
                        color: currentTheme.colors.surface.mutedForeground,
                      }}
                    >
                      No cards
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {cards.map((card: BoardCard) => (
                        <KanbanCard
                          key={card.id}
                          card={card}
                          className="border-interactive-border/30"
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t p-2" style={{ borderColor: `rgb(var(--surface-subtle))` }}>
        <Button
          type="button"
          variant="default"
          size="sm"
          className="w-full"
          onClick={handleOpenBoard}
        >
          Open Board
        </Button>
      </div>
    </div>
  );
};
