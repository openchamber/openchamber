import { runSerializedKanbanMutation, getDefaultBoard } from './storage.js';

class KanbanValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KanbanValidationError';
  }
}

class KanbanNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KanbanNotFoundError';
  }
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBoardToUI(board, projectDirectory) {
  if (!board) return null;
  return {
    projectId: projectDirectory,
    columns: board.columns.map(col => ({
      id: col.id,
      name: col.title,
      order: col.order
    })),
    cards: board.cards.map(card => ({
      id: card.id,
      title: card.title,
      description: card.description,
      worktreeId: card.worktreeId || '',
      columnId: card.columnId,
      order: card.order,
      status: card.status,
      sessionId: card.sessionId
    })),
    updatedAt: board.updatedAt
  };
}

function normalizeOrder(items) {
  return items
    .sort((a, b) => a.order - b.order)
    .map((item, index) => ({ ...item, order: index }));
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export async function getOrCreateBoard(projectDirectory) {
  if (!projectDirectory || typeof projectDirectory !== 'string') {
    throw new KanbanValidationError('Project directory is required');
  }
  const trimmedProjectDir = trimString(projectDirectory);
  if (!trimmedProjectDir) {
    throw new KanbanValidationError('Project directory cannot be empty');
  }

  const storage = await runSerializedKanbanMutation(current => {
    const { boardsByProject } = current;
    if (!boardsByProject[trimmedProjectDir]) {
      const defaultBoard = getDefaultBoard();
      defaultBoard.updatedAt = Date.now();
      boardsByProject[trimmedProjectDir] = defaultBoard;
    }
    return current;
  });

  const board = storage.boardsByProject[trimmedProjectDir];
  return { board: normalizeBoardToUI(board, trimmedProjectDir), projectDirectory: trimmedProjectDir };
}

export async function createColumn(projectDirectory, { name, afterColumnId }) {
  if (!projectDirectory || typeof projectDirectory !== 'string') {
    throw new KanbanValidationError('Project directory is required');
  }
  const trimmedProjectDir = trimString(projectDirectory);
  if (!trimmedProjectDir) {
    throw new KanbanValidationError('Project directory cannot be empty');
  }

  const trimmedName = trimString(name);
  if (!trimmedName) {
    throw new KanbanValidationError('Column name is required');
  }

  const storage = await runSerializedKanbanMutation(current => {
    const { boardsByProject } = current;
    let board = boardsByProject[trimmedProjectDir];
    if (!board) {
      throw new KanbanNotFoundError('Board not found for project directory');
    }

    const columnId = generateId();
    let newOrder = board.columns.length;
    if (afterColumnId) {
      const afterIndex = board.columns.findIndex(c => c.id === afterColumnId);
      if (afterIndex >= 0) {
        newOrder = board.columns[afterIndex].order + 1;
      }
    }

    board.columns.push({
      id: columnId,
      title: trimmedName,
      name: trimmedName,
      order: newOrder
    });

    board.columns = normalizeOrder(board.columns);
    board.updatedAt = Date.now();

    return current;
  });

  const board = storage.boardsByProject[trimmedProjectDir];
  return { board: normalizeBoardToUI(board, trimmedProjectDir) };
}

export async function renameColumn(projectDirectory, columnId, { name }) {
  if (!projectDirectory || typeof projectDirectory !== 'string') {
    throw new KanbanValidationError('Project directory is required');
  }
  const trimmedProjectDir = trimString(projectDirectory);
  if (!trimmedProjectDir) {
    throw new KanbanValidationError('Project directory cannot be empty');
  }

  if (!columnId || typeof columnId !== 'string') {
    throw new KanbanValidationError('Column ID is required');
  }

  const trimmedName = trimString(name);
  if (!trimmedName) {
    throw new KanbanValidationError('Column name is required');
  }

  const storage = await runSerializedKanbanMutation(current => {
    const { boardsByProject } = current;
    const board = boardsByProject[trimmedProjectDir];
    if (!board) {
      throw new KanbanNotFoundError('Board not found for project directory');
    }

    const column = board.columns.find(c => c.id === columnId);
    if (!column) {
      throw new KanbanNotFoundError('Column not found');
    }

    column.title = trimmedName;
    column.name = trimmedName;
    board.updatedAt = Date.now();

    return current;
  });

  const board = storage.boardsByProject[trimmedProjectDir];
  return { board: normalizeBoardToUI(board, trimmedProjectDir) };
}

export async function deleteColumn(projectDirectory, columnId) {
  if (!projectDirectory || typeof projectDirectory !== 'string') {
    throw new KanbanValidationError('Project directory is required');
  }
  const trimmedProjectDir = trimString(projectDirectory);
  if (!trimmedProjectDir) {
    throw new KanbanValidationError('Project directory cannot be empty');
  }

  if (!columnId || typeof columnId !== 'string') {
    throw new KanbanValidationError('Column ID is required');
  }

  const storage = await runSerializedKanbanMutation(current => {
    const { boardsByProject } = current;
    const board = boardsByProject[trimmedProjectDir];
    if (!board) {
      throw new KanbanNotFoundError('Board not found for project directory');
    }

    const columnIndex = board.columns.findIndex(c => c.id === columnId);
    if (columnIndex < 0) {
      throw new KanbanNotFoundError('Column not found');
    }

    board.columns.splice(columnIndex, 1);
    board.columns = normalizeOrder(board.columns);
    board.cards = board.cards.filter(card => card.columnId !== columnId);
    board.updatedAt = Date.now();

    return current;
  });

  const board = storage.boardsByProject[trimmedProjectDir];
  return { board: normalizeBoardToUI(board, trimmedProjectDir) };
}

export async function createCard(projectDirectory, { columnId, title, description, worktreeId }) {
  if (!projectDirectory || typeof projectDirectory !== 'string') {
    throw new KanbanValidationError('Project directory is required');
  }
  const trimmedProjectDir = trimString(projectDirectory);
  if (!trimmedProjectDir) {
    throw new KanbanValidationError('Project directory cannot be empty');
  }

  if (!columnId || typeof columnId !== 'string') {
    throw new KanbanValidationError('Column ID is required');
  }

  const trimmedTitle = trimString(title);
  if (!trimmedTitle) {
    throw new KanbanValidationError('Card title is required');
  }

  const trimmedDescription = trimString(description || '');
  if (!trimmedDescription) {
    throw new KanbanValidationError('Card description is required');
  }

  const trimmedWorktreeId = trimString(worktreeId || '');
  if (!trimmedWorktreeId) {
    throw new KanbanValidationError('Worktree ID is required');
  }

  const storage = await runSerializedKanbanMutation(current => {
    const { boardsByProject } = current;
    const board = boardsByProject[trimmedProjectDir];
    if (!board) {
      throw new KanbanNotFoundError('Board not found for project directory');
    }

    const column = board.columns.find(c => c.id === columnId);
    if (!column) {
      throw new KanbanNotFoundError('Column not found');
    }

    const cardId = generateId();
    const columnCards = board.cards.filter(c => c.columnId === columnId);
    const newOrder = columnCards.length;

    board.cards.push({
      id: cardId,
      title: trimmedTitle,
      description: trimmedDescription,
      worktreeId: trimmedWorktreeId,
      columnId,
      order: newOrder,
      updatedAt: Date.now()
    });

    board.updatedAt = Date.now();

    return current;
  });

  const board = storage.boardsByProject[trimmedProjectDir];
  return { board: normalizeBoardToUI(board, trimmedProjectDir) };
}

export async function updateCard(projectDirectory, cardId, { title, description, worktreeId }) {
  if (!projectDirectory || typeof projectDirectory !== 'string') {
    throw new KanbanValidationError('Project directory is required');
  }
  const trimmedProjectDir = trimString(projectDirectory);
  if (!trimmedProjectDir) {
    throw new KanbanValidationError('Project directory cannot be empty');
  }

  if (!cardId || typeof cardId !== 'string') {
    throw new KanbanValidationError('Card ID is required');
  }

  const storage = await runSerializedKanbanMutation(current => {
    const { boardsByProject } = current;
    const board = boardsByProject[trimmedProjectDir];
    if (!board) {
      throw new KanbanNotFoundError('Board not found for project directory');
    }

    const card = board.cards.find(c => c.id === cardId);
    if (!card) {
      throw new KanbanNotFoundError('Card not found');
    }

    if (title !== undefined) {
      const trimmedTitle = trimString(title);
      if (!trimmedTitle) {
        throw new KanbanValidationError('Card title cannot be empty');
      }
      card.title = trimmedTitle;
    }

    if (description !== undefined) {
      const trimmedDescription = trimString(description);
      if (!trimmedDescription) {
        throw new KanbanValidationError('Card description cannot be empty');
      }
      card.description = trimmedDescription;
    }

    if (worktreeId !== undefined) {
      const trimmedWorktreeId = trimString(worktreeId);
      if (!trimmedWorktreeId) {
        throw new KanbanValidationError('Worktree ID cannot be empty');
      }
      card.worktreeId = trimmedWorktreeId;
    }

    card.updatedAt = Date.now();
    board.updatedAt = Date.now();

    return current;
  });

  const board = storage.boardsByProject[trimmedProjectDir];
  return { board: normalizeBoardToUI(board, trimmedProjectDir) };
}

export async function deleteCard(projectDirectory, cardId) {
  if (!projectDirectory || typeof projectDirectory !== 'string') {
    throw new KanbanValidationError('Project directory is required');
  }
  const trimmedProjectDir = trimString(projectDirectory);
  if (!trimmedProjectDir) {
    throw new KanbanValidationError('Project directory cannot be empty');
  }

  if (!cardId || typeof cardId !== 'string') {
    throw new KanbanValidationError('Card ID is required');
  }

  const storage = await runSerializedKanbanMutation(current => {
    const { boardsByProject } = current;
    const board = boardsByProject[trimmedProjectDir];
    if (!board) {
      throw new KanbanNotFoundError('Board not found for project directory');
    }

    const cardIndex = board.cards.findIndex(c => c.id === cardId);
    if (cardIndex < 0) {
      throw new KanbanNotFoundError('Card not found');
    }

    const card = board.cards[cardIndex];
    const columnId = card.columnId;
    board.cards.splice(cardIndex, 1);

    const columnCards = board.cards.filter(c => c.columnId === columnId);
    board.cards = board.cards.filter(c => c.columnId !== columnId).concat(normalizeOrder(columnCards));

    board.updatedAt = Date.now();

    return current;
  });

  const board = storage.boardsByProject[trimmedProjectDir];
  return { board: normalizeBoardToUI(board, trimmedProjectDir) };
}

export async function moveCard(projectDirectory, cardId, { toColumnId, toOrder }) {
  if (!projectDirectory || typeof projectDirectory !== 'string') {
    throw new KanbanValidationError('Project directory is required');
  }
  const trimmedProjectDir = trimString(projectDirectory);
  if (!trimmedProjectDir) {
    throw new KanbanValidationError('Project directory cannot be empty');
  }

  if (!cardId || typeof cardId !== 'string') {
    throw new KanbanValidationError('Card ID is required');
  }

  if (!toColumnId || typeof toColumnId !== 'string') {
    throw new KanbanValidationError('Target column ID is required');
  }

  if (typeof toOrder !== 'number' || toOrder < 0) {
    throw new KanbanValidationError('Target order must be a non-negative number');
  }

  const storage = await runSerializedKanbanMutation(current => {
    const { boardsByProject } = current;
    const board = boardsByProject[trimmedProjectDir];
    if (!board) {
      throw new KanbanNotFoundError('Board not found for project directory');
    }

    const card = board.cards.find(c => c.id === cardId);
    if (!card) {
      throw new KanbanNotFoundError('Card not found');
    }

    const toColumn = board.columns.find(c => c.id === toColumnId);
    if (!toColumn) {
      throw new KanbanNotFoundError('Target column not found');
    }

    const fromColumnId = card.columnId;
    card.columnId = toColumnId;
    card.order = toOrder;

    const fromColumnCards = board.cards.filter(c => c.columnId === fromColumnId && c.id !== cardId);
    board.cards = board.cards.filter(c => c.columnId !== fromColumnId && c.id !== cardId)
      .concat(normalizeOrder(fromColumnCards))
      .concat([card]);

    const toColumnCards = board.cards.filter(c => c.columnId === toColumnId);
    board.cards = board.cards.filter(c => c.columnId !== toColumnId)
      .concat(normalizeOrder(toColumnCards));

    board.updatedAt = Date.now();

    return current;
  });

  const board = storage.boardsByProject[trimmedProjectDir];
  return { board: normalizeBoardToUI(board, trimmedProjectDir) };
}

export { KanbanValidationError, KanbanNotFoundError };
