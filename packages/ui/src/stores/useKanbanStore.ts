import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import {
  createCard as apiCreateCard,
  createColumn as apiCreateColumn,
  deleteCard as apiDeleteCard,
  deleteColumn as apiDeleteColumn,
  getBoard,
  moveCard as apiMoveCard,
  renameColumn as apiRenameColumn,
  updateCard as apiUpdateCard,
  updateColumnAutomation as apiUpdateColumnAutomation,
} from '@/lib/kanbanApi';
import type { BoardCard, ProjectBoard } from '@/types/kanban';
import type { KanbanUpdateColumnAutomationPayload } from '@/lib/api/types';

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
};

const withProjectId = (board: ProjectBoard, projectId: string): ProjectBoard => {
  if (board.projectId === projectId) {
    return board;
  }
  return {
    ...board,
    projectId,
  };
};

interface KanbanStore {
  boards: Map<string, ProjectBoard>;
  isLoadingByProject: Map<string, boolean>;
  isMutatingByProject: Map<string, boolean>;
  errorByProject: Map<string, string | null>;
  hydratedProjects: Set<string>;

  hydrateProjectBoard: (projectId: string, directory: string) => Promise<void>;
  resetProjectBoard: (projectId: string) => void;
  getProjectBoard: (projectId: string) => ProjectBoard | null;

  createColumn: (projectId: string, directory: string, name: string, afterColumnId?: string) => Promise<void>;
  renameColumn: (projectId: string, directory: string, columnId: string, name: string) => Promise<void>;
  deleteColumn: (projectId: string, directory: string, columnId: string) => Promise<void>;
  createCard: (
    projectId: string,
    directory: string,
    columnId: string,
    title: string,
    description: string,
    worktreeId: string,
  ) => Promise<void>;
  updateCard: (projectId: string, directory: string, cardId: string, updates: Partial<BoardCard>) => Promise<void>;
  deleteCard: (projectId: string, directory: string, cardId: string) => Promise<void>;
  moveCard: (projectId: string, directory: string, cardId: string, toColumnId: string, toOrder?: number) => Promise<void>;
  updateColumnAutomation: (
    projectId: string,
    directory: string,
    columnId: string,
    payload: KanbanUpdateColumnAutomationPayload,
  ) => Promise<void>;

  startBoardSync: (projectId: string, directory: string) => void;
  stopBoardSync: (projectId: string) => void;

  syncIntervals: Map<string, ReturnType<typeof setInterval>>;
  syncConsumers: Map<string, number>;
  syncDirectories: Map<string, string>;
}

export const useKanbanStore = create<KanbanStore>()(
  devtools(
    (set, get) => {
      const syncInFlight = new Set<string>();

      const setProjectLoading = (projectId: string, isLoading: boolean) => {
        set((state) => {
          const next = new Map(state.isLoadingByProject);
          next.set(projectId, isLoading);
          return { isLoadingByProject: next };
        });
      };

      const setProjectMutating = (projectId: string, isMutating: boolean) => {
        set((state) => {
          const next = new Map(state.isMutatingByProject);
          next.set(projectId, isMutating);
          return { isMutatingByProject: next };
        });
      };

      const setProjectError = (projectId: string, error: string | null) => {
        set((state) => {
          const next = new Map(state.errorByProject);
          next.set(projectId, error);
          return { errorByProject: next };
        });
      };

      const applyBoard = (projectId: string, board: ProjectBoard) => {
        set((state) => {
          const nextBoards = new Map(state.boards);
          nextBoards.set(projectId, withProjectId(board, projectId));
          return { boards: nextBoards };
        });
        reconcilePolling(projectId);
      };

      const hasRunningCards = (projectId: string): boolean => {
        const board = get().boards.get(projectId);
        if (!board) return false;
        return board.cards.some((card) => card.status === 'running');
      };

      const shouldContinuePolling = (projectId: string): boolean => {
        const consumers = get().syncConsumers.get(projectId) ?? 0;
        return consumers > 0 || hasRunningCards(projectId);
      };

      const silentRefreshBoard = async (projectId: string): Promise<void> => {
        const directory = get().syncDirectories.get(projectId);
        if (!directory || syncInFlight.has(projectId)) return;

        syncInFlight.add(projectId);

        try {
          const response = await getBoard(directory);
          applyBoard(projectId, response.board);
        } catch (error) {
          console.error(`[KanbanSync] Background sync failed for ${projectId}:`, error);
        } finally {
          syncInFlight.delete(projectId);
          reconcilePolling(projectId);
        }
      };

      const startPolling = (projectId: string): void => {
        const { syncIntervals, syncDirectories } = get();
        const directory = syncDirectories.get(projectId);

        if (syncIntervals.has(projectId) || !directory) return;

        const intervalId = setInterval(() => {
          if (!shouldContinuePolling(projectId)) {
            reconcilePolling(projectId);
            return;
          }
          void silentRefreshBoard(projectId);
        }, 2000);

        set((state) => ({
          syncIntervals: new Map(state.syncIntervals).set(projectId, intervalId),
        }));
      };

      const stopPolling = (projectId: string): void => {
        const { syncIntervals } = get();
        const intervalId = syncIntervals.get(projectId);

        if (intervalId) {
          clearInterval(intervalId);
          set((state) => {
            const nextIntervals = new Map(state.syncIntervals);
            nextIntervals.delete(projectId);
            return { syncIntervals: nextIntervals };
          });
        }
      };

      function reconcilePolling(projectId: string): void {
        const { syncDirectories, syncIntervals, syncConsumers } = get();
        const hasDirectory = Boolean(syncDirectories.get(projectId));
        const shouldPoll = hasDirectory && shouldContinuePolling(projectId);
        const polling = syncIntervals.has(projectId);

        if (shouldPoll && !polling) {
          startPolling(projectId);
          return;
        }

        if (!shouldPoll && polling) {
          stopPolling(projectId);
        }

        if (!shouldPoll && hasDirectory && (syncConsumers.get(projectId) ?? 0) === 0) {
          set((state) => {
            const nextDirectories = new Map(state.syncDirectories);
            nextDirectories.delete(projectId);
            return { syncDirectories: nextDirectories };
          });
        }
      }

      const runProjectMutation = async (
        projectId: string,
        directory: string,
        request: () => Promise<{ board: ProjectBoard }>,
        fallbackError: string,
      ) => {
        if (!projectId || !directory.trim()) {
          return;
        }

        setProjectMutating(projectId, true);
        setProjectError(projectId, null);

        try {
          const response = await request();
          applyBoard(projectId, response.board);
          setProjectMutating(projectId, false);
        } catch (error) {
          setProjectMutating(projectId, false);
          setProjectError(projectId, getErrorMessage(error, fallbackError));
          throw error;
        }
      };

      return {
        boards: new Map(),
        isLoadingByProject: new Map(),
        isMutatingByProject: new Map(),
        errorByProject: new Map(),
        hydratedProjects: new Set(),

        hydrateProjectBoard: async (projectId: string, directory: string) => {
          if (!projectId || !directory.trim()) {
            return;
          }

          const { hydratedProjects, isLoadingByProject } = get();
          if (hydratedProjects.has(projectId) || isLoadingByProject.get(projectId)) {
            return;
          }

          setProjectLoading(projectId, true);
          setProjectError(projectId, null);

          try {
            const response = await getBoard(directory);

            set((state) => {
              const nextBoards = new Map(state.boards);
              nextBoards.set(projectId, withProjectId(response.board, projectId));

              const nextLoading = new Map(state.isLoadingByProject);
              nextLoading.set(projectId, false);

              const nextHydrated = new Set(state.hydratedProjects);
              nextHydrated.add(projectId);

              const nextErrors = new Map(state.errorByProject);
              nextErrors.set(projectId, null);

              return {
                boards: nextBoards,
                isLoadingByProject: nextLoading,
                hydratedProjects: nextHydrated,
                errorByProject: nextErrors,
              };
            });
            reconcilePolling(projectId);
          } catch (error) {
            setProjectLoading(projectId, false);
            setProjectError(projectId, getErrorMessage(error, 'Failed to load board'));
            throw error;
          }
        },

        resetProjectBoard: (projectId: string) => {
          stopPolling(projectId);

          set((state) => {
            const nextBoards = new Map(state.boards);
            nextBoards.delete(projectId);

            const nextLoading = new Map(state.isLoadingByProject);
            nextLoading.delete(projectId);

            const nextMutating = new Map(state.isMutatingByProject);
            nextMutating.delete(projectId);

            const nextErrors = new Map(state.errorByProject);
            nextErrors.delete(projectId);

            const nextHydrated = new Set(state.hydratedProjects);
            nextHydrated.delete(projectId);

            const nextConsumers = new Map(state.syncConsumers);
            nextConsumers.delete(projectId);

            const nextDirectories = new Map(state.syncDirectories);
            nextDirectories.delete(projectId);

            return {
              boards: nextBoards,
              isLoadingByProject: nextLoading,
              isMutatingByProject: nextMutating,
              errorByProject: nextErrors,
              hydratedProjects: nextHydrated,
              syncConsumers: nextConsumers,
              syncDirectories: nextDirectories,
            };
          });
        },

        getProjectBoard: (projectId: string) => {
          if (!projectId) {
            return null;
          }
          return get().boards.get(projectId) ?? null;
        },

        createColumn: async (projectId: string, directory: string, name: string, afterColumnId?: string) => {
          await runProjectMutation(
            projectId,
            directory,
            () => apiCreateColumn(directory, name, afterColumnId),
            'Failed to create column',
          );
        },

        renameColumn: async (projectId: string, directory: string, columnId: string, name: string) => {
          await runProjectMutation(
            projectId,
            directory,
            () => apiRenameColumn(directory, columnId, name),
            'Failed to rename column',
          );
        },

        deleteColumn: async (projectId: string, directory: string, columnId: string) => {
          await runProjectMutation(
            projectId,
            directory,
            () => apiDeleteColumn(directory, columnId),
            'Failed to delete column',
          );
        },

        createCard: async (
          projectId: string,
          directory: string,
          columnId: string,
          title: string,
          description: string,
          worktreeId: string,
        ) => {
          await runProjectMutation(
            projectId,
            directory,
            () => apiCreateCard(directory, columnId, title, description, worktreeId),
            'Failed to create card',
          );
        },

        updateCard: async (projectId: string, directory: string, cardId: string, updates: Partial<BoardCard>) => {
          await runProjectMutation(
            projectId,
            directory,
            () => apiUpdateCard(directory, cardId, updates),
            'Failed to update card',
          );
        },

        deleteCard: async (projectId: string, directory: string, cardId: string) => {
          await runProjectMutation(
            projectId,
            directory,
            () => apiDeleteCard(directory, cardId),
            'Failed to delete card',
          );
        },

        moveCard: async (projectId: string, directory: string, cardId: string, toColumnId: string, toOrder?: number) => {
          await runProjectMutation(
            projectId,
            directory,
            () => apiMoveCard(directory, cardId, toColumnId, toOrder),
            'Failed to move card',
          );
        },

        updateColumnAutomation: async (
          projectId: string,
          directory: string,
          columnId: string,
          payload: KanbanUpdateColumnAutomationPayload,
        ) => {
          await runProjectMutation(
            projectId,
            directory,
            () => apiUpdateColumnAutomation(directory, columnId, payload),
            'Failed to update column automation',
          );
        },

        startBoardSync: (projectId: string, directory: string) => {
          const trimmedDirectory = directory.trim();
          if (!projectId || !trimmedDirectory) {
            return;
          }

          set((state) => {
            const nextConsumers = new Map(state.syncConsumers);
            const currentConsumers = nextConsumers.get(projectId) ?? 0;
            nextConsumers.set(projectId, currentConsumers + 1);

            const nextDirectories = new Map(state.syncDirectories);
            nextDirectories.set(projectId, trimmedDirectory);

            return {
              syncConsumers: nextConsumers,
              syncDirectories: nextDirectories,
            };
          });

          void silentRefreshBoard(projectId);
          reconcilePolling(projectId);
        },

        stopBoardSync: (projectId: string) => {
          if (!projectId) {
            return;
          }

          const { syncConsumers } = get();
          const currentConsumers = syncConsumers.get(projectId) ?? 0;
          const nextConsumerCount = Math.max(0, currentConsumers - 1);

          set((state) => {
            const nextConsumers = new Map(state.syncConsumers);
            if (nextConsumerCount > 0) {
              nextConsumers.set(projectId, nextConsumerCount);
            } else {
              nextConsumers.delete(projectId);
            }

            const nextDirectories = new Map(state.syncDirectories);
            const keepDirectory = nextConsumerCount > 0 || hasRunningCards(projectId);
            if (!keepDirectory) {
              nextDirectories.delete(projectId);
            }

            return {
              syncConsumers: nextConsumers,
              syncDirectories: nextDirectories,
            };
          });

          reconcilePolling(projectId);

          if (!hasRunningCards(projectId) && nextConsumerCount === 0) {
            stopPolling(projectId);
          }
        },

        syncIntervals: new Map(),
        syncConsumers: new Map(),
        syncDirectories: new Map(),
      };
    },
    { name: 'kanban-store' },
  ),
);

export const getActiveProjectBoard = (projectId: string | null): ProjectBoard | null => {
  if (!projectId) {
    return null;
  }
  return useKanbanStore.getState().getProjectBoard(projectId);
};
