import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { ProjectBoard, BoardColumn, BoardCard } from '@/types/kanban';

const createBoardId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

const createDefaultBoard = (projectId: string): ProjectBoard => {
  const now = Date.now();
  return {
    projectId,
    columns: [
      { id: 'col_backlog', name: 'Backlog', order: 0 },
      { id: 'col_in_progress', name: 'In Progress', order: 1 },
      { id: 'col_done', name: 'Done', order: 2 },
    ],
    cards: [],
    updatedAt: now,
  };
};

const recalculateColumnOrders = (columns: BoardColumn[]): BoardColumn[] => {
  return columns.map((col, index) => ({ ...col, order: index }));
};

const recalculateCardOrders = (cards: BoardCard[]): BoardCard[] => {
  const cardsByColumn = new Map<string, BoardCard[]>();
  for (const card of cards) {
    if (!cardsByColumn.has(card.columnId)) {
      cardsByColumn.set(card.columnId, []);
    }
    cardsByColumn.get(card.columnId)!.push(card);
  }

  const result: BoardCard[] = [];
  const columnCardsArray = Array.from(cardsByColumn.values());
  for (const columnCards of columnCardsArray) {
    columnCards.sort((a, b) => a.order - b.order);
    columnCards.forEach((card, index) => {
      result.push({ ...card, order: index });
    });
  }
  return result;
};

interface KanbanStore {
  boards: Map<string, ProjectBoard>;

  ensureProjectBoard: (projectId: string) => ProjectBoard;
  resetProjectBoard: (projectId: string) => void;
  getProjectBoard: (projectId: string) => ProjectBoard | null;
  createColumn: (projectId: string, name: string, afterColumnId?: string) => void;
  renameColumn: (projectId: string, columnId: string, name: string) => void;
  deleteColumn: (projectId: string, columnId: string) => void;
  createCard: (projectId: string, columnId: string, title: string, description: string, worktreeId: string) => void;
  updateCard: (projectId: string, cardId: string, updates: Partial<BoardCard>) => void;
  deleteCard: (projectId: string, cardId: string) => void;
  moveCard: (projectId: string, cardId: string, toColumnId: string, toOrder?: number) => void;
  reorderCardsInColumn: (projectId: string, columnId: string, fromOrder: number, toOrder: number) => void;
}

export const useKanbanStore = create<KanbanStore>()(
  devtools(
    (set, get) => ({
      boards: new Map(),

      ensureProjectBoard: (projectId: string) => {
        const { boards } = get();
        if (!boards.has(projectId)) {
          set((state) => {
            const newBoards = new Map(state.boards);
            newBoards.set(projectId, createDefaultBoard(projectId));
            return { boards: newBoards };
          });
          return createDefaultBoard(projectId);
        }
        return boards.get(projectId)!;
      },

      resetProjectBoard: (projectId: string) => {
        set((state) => {
          const newBoards = new Map(state.boards);
          newBoards.set(projectId, createDefaultBoard(projectId));
          return { boards: newBoards };
        });
      },

      getProjectBoard: (projectId: string) => {
        return get().boards.get(projectId) ?? null;
      },

      createColumn: (projectId: string, name: string, afterColumnId?: string) => {
        set((state) => {
          const board = state.boards.get(projectId);
          if (!board) return state;

          const columns = [...board.columns];
          let newOrder = columns.length;

          if (afterColumnId) {
            const afterIndex = columns.findIndex((c) => c.id === afterColumnId);
            if (afterIndex !== -1) {
              newOrder = columns[afterIndex].order + 1;
            }
          }

          const newColumn: BoardColumn = {
            id: createBoardId(),
            name: name.trim(),
            order: newOrder,
          };

          const updatedColumns = [...columns, newColumn];
          const recalculatedColumns = recalculateColumnOrders(updatedColumns);

          const newBoards = new Map(state.boards);
          newBoards.set(projectId, {
            ...board,
            columns: recalculatedColumns,
            updatedAt: Date.now(),
          });

          return { boards: newBoards };
        });
      },

      renameColumn: (projectId: string, columnId: string, name: string) => {
        set((state) => {
          const board = state.boards.get(projectId);
          if (!board) return state;

          const trimmedName = name.trim();
          if (!trimmedName) return state;

          const updatedColumns = board.columns.map((col) =>
            col.id === columnId ? { ...col, name: trimmedName } : col
          );

          const newBoards = new Map(state.boards);
          newBoards.set(projectId, {
            ...board,
            columns: updatedColumns,
            updatedAt: Date.now(),
          });

          return { boards: newBoards };
        });
      },

      deleteColumn: (projectId: string, columnId: string) => {
        set((state) => {
          const board = state.boards.get(projectId);
          if (!board) return state;

          const updatedColumns = board.columns.filter((col) => col.id !== columnId);
          const recalculatedColumns = recalculateColumnOrders(updatedColumns);

          const updatedCards = board.cards.filter((card) => card.columnId !== columnId);
          const recalculatedCards = recalculateCardOrders(updatedCards);

          const newBoards = new Map(state.boards);
          newBoards.set(projectId, {
            ...board,
            columns: recalculatedColumns,
            cards: recalculatedCards,
            updatedAt: Date.now(),
          });

          return { boards: newBoards };
        });
      },

      createCard: (projectId: string, columnId: string, title: string, description: string, worktreeId: string) => {
        set((state) => {
          const board = state.boards.get(projectId);
          if (!board) return state;

          const columnCards = board.cards.filter((c) => c.columnId === columnId);
          const newOrder = columnCards.length;

          const newCard: BoardCard = {
            id: createBoardId(),
            title: title.trim(),
            description: description.trim(),
            worktreeId,
            columnId,
            order: newOrder,
          };

          const updatedCards = [...board.cards, newCard];
          const recalculatedCards = recalculateCardOrders(updatedCards);

          const newBoards = new Map(state.boards);
          newBoards.set(projectId, {
            ...board,
            cards: recalculatedCards,
            updatedAt: Date.now(),
          });

          return { boards: newBoards };
        });
      },

      updateCard: (projectId: string, cardId: string, updates: Partial<BoardCard>) => {
        set((state) => {
          const board = state.boards.get(projectId);
          if (!board) return state;

          const card = board.cards.find((c) => c.id === cardId);
          if (!card) return state;

          const updatedCards = board.cards.map((c) =>
            c.id === cardId ? { ...c, ...updates } : c
          );

          const newBoards = new Map(state.boards);
          newBoards.set(projectId, {
            ...board,
            cards: updatedCards,
            updatedAt: Date.now(),
          });

          return { boards: newBoards };
        });
      },

      deleteCard: (projectId: string, cardId: string) => {
        set((state) => {
          const board = state.boards.get(projectId);
          if (!board) return state;

          const card = board.cards.find((c) => c.id === cardId);
          if (!card) return state;

          const updatedCards = board.cards.filter((c) => c.id !== cardId);
          const recalculatedCards = recalculateCardOrders(updatedCards);

          const newBoards = new Map(state.boards);
          newBoards.set(projectId, {
            ...board,
            cards: recalculatedCards,
            updatedAt: Date.now(),
          });

          return { boards: newBoards };
        });
      },

      moveCard: (projectId: string, cardId: string, toColumnId: string, toOrder?: number) => {
        set((state) => {
          const board = state.boards.get(projectId);
          if (!board) return state;

          const card = board.cards.find((c) => c.id === cardId);
          if (!card) return state;

          const targetColumnExists = board.columns.some((c) => c.id === toColumnId);
          if (!targetColumnExists) return state;

          let updatedCards = board.cards.map((c) => {
            if (c.id === cardId) {
              return { ...c, columnId: toColumnId };
            }
            return c;
          });

          if (toOrder !== undefined) {
            const cardsInTargetColumn = updatedCards.filter((c) => c.columnId === toColumnId && c.id !== cardId);
            const cardsInOtherColumns = updatedCards.filter((c) => c.columnId !== toColumnId);
            
            cardsInTargetColumn.sort((a, b) => a.order - b.order);
            cardsInTargetColumn.splice(toOrder, 0, { ...card, columnId: toColumnId, order: toOrder });
            
            const reorderedTargetColumn = cardsInTargetColumn.map((c, idx) => ({ ...c, order: idx }));
            updatedCards = [...cardsInOtherColumns, ...reorderedTargetColumn];
          }

          const recalculatedCards = recalculateCardOrders(updatedCards);

          const newBoards = new Map(state.boards);
          newBoards.set(projectId, {
            ...board,
            cards: recalculatedCards,
            updatedAt: Date.now(),
          });

          return { boards: newBoards };
        });
      },

      reorderCardsInColumn: (projectId: string, columnId: string, fromOrder: number, toOrder: number) => {
        set((state) => {
          const board = state.boards.get(projectId);
          if (!board) return state;

          const cardsInColumn = board.cards.filter((c) => c.columnId === columnId);
          if (fromOrder < 0 || fromOrder >= cardsInColumn.length || toOrder < 0 || toOrder >= cardsInColumn.length) {
            return state;
          }

          const cardsInOtherColumns = board.cards.filter((c) => c.columnId !== columnId);

          const sortedColumnCards = [...cardsInColumn].sort((a, b) => a.order - b.order);
          const [moved] = sortedColumnCards.splice(fromOrder, 1);
          sortedColumnCards.splice(toOrder, 0, moved);

          const reorderedColumnCards = sortedColumnCards.map((card, idx) => ({ ...card, order: idx }));

          const updatedCards = [...cardsInOtherColumns, ...reorderedColumnCards];

          const newBoards = new Map(state.boards);
          newBoards.set(projectId, {
            ...board,
            cards: updatedCards,
            updatedAt: Date.now(),
          });

          return { boards: newBoards };
        });
      },
    }),
    { name: 'kanban-store' }
  )
);

export const getActiveProjectBoard = (projectId: string | null): ProjectBoard | null => {
  if (!projectId) return null;
  return useKanbanStore.getState().getProjectBoard(projectId);
};
