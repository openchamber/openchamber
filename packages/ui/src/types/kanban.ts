export type BoardCardStatus = 'running' | 'done' | 'failed';

export interface BoardColumnAutomation {
  onEnterText: string;
  agent: string;
  providerID: string;
  modelID: string;
  variant?: string;
  onFinishMoveTo?: string;
}

export interface BoardColumn {
  id: string;
  name: string;
  order: number;
  automation?: BoardColumnAutomation;
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
