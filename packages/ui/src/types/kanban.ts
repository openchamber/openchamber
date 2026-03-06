export type BoardCardStatus = 'running' | 'done';

export interface BoardColumn {
  id: string;
  name: string;
  order: number;
}

export interface BoardCard {
  id: string;
  title: string;
  description: string;
  worktreeId: string;
  columnId: string;
  order: number;
  status?: BoardCardStatus;
  sessionId?: string;
}

export interface ProjectBoard {
  projectId: string;
  columns: BoardColumn[];
  cards: BoardCard[];
  updatedAt: number;
}
