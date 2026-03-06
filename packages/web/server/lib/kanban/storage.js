import fs from 'fs';
import path from 'path';
import os from 'os';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const STORAGE_FILE = path.join(OPENCHAMBER_DATA_DIR, 'kanban-boards.json');
const STORAGE_VERSION = 1;

let persistKanbanLock = Promise.resolve();

function ensureStorageDir() {
  if (!fs.existsSync(OPENCHAMBER_DATA_DIR)) {
    fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
  }
}

function readStorageFile() {
  ensureStorageDir();
  if (!fs.existsSync(STORAGE_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Storage file is not an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to read Kanban storage file: ${error.message}`);
  }
}

function writeStorageFile(data) {
  ensureStorageDir();
  const tmpFile = `${STORAGE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
  }
  fs.renameSync(tmpFile, STORAGE_FILE);
  try {
    fs.chmodSync(STORAGE_FILE, 0o600);
  } catch {
  }
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProjectPath(projectPath) {
  const trimmed = trimString(projectPath);
  if (!trimmed) {
    return '';
  }
  return path.resolve(trimmed);
}

function validateId(id) {
  return typeof id === 'string' && id.trim().length > 0;
}

function validateCard(card) {
  if (!card || typeof card !== 'object') {
    return null;
  }
  const id = trimString(card.id);
  const title = trimString(card.title);
  const description = trimString(card.description || '');
  const worktreeId = trimString(card.worktreeId);
  const columnId = trimString(card.columnId);
  if (!validateId(id) || !title || !description || !worktreeId || !columnId) {
    return null;
  }
  const result = {
    id,
    title,
    description,
    worktreeId,
    columnId,
    order: typeof card.order === 'number' ? card.order : 0,
    updatedAt: typeof card.updatedAt === 'number' ? card.updatedAt : Date.now(),
  };
  if (typeof card.status === 'string') {
    result.status = trimString(card.status);
  }
  if (typeof card.sessionId === 'string') {
    result.sessionId = trimString(card.sessionId);
  }
  return result;
}

function validateColumn(column) {
  if (!column || typeof column !== 'object') {
    return null;
  }
  const id = trimString(column.id);
  const name = trimString(column.name || column.title);
  if (!validateId(id) || !name) {
    return null;
  }
  return {
    id,
    title: name,
    name,
    order: typeof column.order === 'number' ? column.order : 0,
  };
}

function validateBoard(board) {
  if (!board || typeof board !== 'object') {
    return null;
  }
  const id = trimString(board.id);
  if (!validateId(id)) {
    return null;
  }
  const rawColumns = Array.isArray(board.columns) ? board.columns : [];
  const rawCards = Array.isArray(board.cards) ? board.cards : [];
  const validColumns = rawColumns.map(validateColumn).filter(Boolean);
  const validCards = rawCards.map(validateCard).filter(Boolean);
  const columnIds = new Set(validColumns.map((c) => c.id));
  const validCardsInColumns = validCards.filter((card) => columnIds.has(card.columnId));
  return {
    id,
    columns: validColumns,
    cards: validCardsInColumns,
    updatedAt: typeof board.updatedAt === 'number' ? board.updatedAt : Date.now(),
  };
}

function normalizeColumnOrder(columns) {
  return columns
    .map((col, index) => ({
      ...col,
      order: typeof col.order === 'number' ? col.order : index,
    }))
    .sort((a, b) => a.order - b.order);
}

function normalizeCardOrder(cards, columns) {
  const normalizedCards = [];

  for (const column of columns) {
    const cardsInColumn = cards
      .filter((card) => card.columnId === column.id)
      .map((card, index) => ({
        ...card,
        order: typeof card.order === 'number' ? card.order : index,
      }))
      .sort((a, b) => a.order - b.order)
      .map((card, index) => ({
        ...card,
        order: index,
      }));

    normalizedCards.push(...cardsInColumn);
  }

  return normalizedCards;
}

function createDefaultBoard() {
  const now = Date.now();
  return {
    id: 'default',
    columns: [
      { id: 'backlog', title: 'Backlog', name: 'Backlog', order: 0 },
      { id: 'in-progress', title: 'In Progress', name: 'In Progress', order: 1 },
      { id: 'done', title: 'Done', name: 'Done', order: 2 },
    ],
    cards: [],
    updatedAt: now,
  };
}

function sanitizeStorageEnvelope(data) {
  if (!data || typeof data !== 'object') {
    return {
      version: STORAGE_VERSION,
      boardsByProject: {},
    };
  }
  const boardsByProjectRaw = typeof data.boardsByProject === 'object' && data.boardsByProject !== null
    ? data.boardsByProject
    : {};
  const boardsByProject = {};
  Object.entries(boardsByProjectRaw).forEach(([projectPath, board]) => {
    const normalizedPath = normalizeProjectPath(projectPath);
    if (!normalizedPath) {
      return;
    }
    const validBoard = validateBoard(board);
    if (!validBoard) {
      return;
    }
    validBoard.columns = normalizeColumnOrder(validBoard.columns);
    validBoard.cards = normalizeCardOrder(validBoard.cards, validBoard.columns);
    boardsByProject[normalizedPath] = validBoard;
  });
  return {
    version: STORAGE_VERSION,
    boardsByProject,
  };
}

export async function readKanbanStorage() {
  const data = readStorageFile();
  if (!data) {
    return {
      version: STORAGE_VERSION,
      boardsByProject: {},
    };
  }
  const sanitized = sanitizeStorageEnvelope(data);
  if (sanitized.version !== STORAGE_VERSION) {
    console.warn(`Kanban storage version mismatch: expected ${STORAGE_VERSION}, got ${sanitized.version}`);
  }
  return sanitized;
}

export async function writeKanbanStorage(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid storage data: must be an object');
  }
  const sanitized = sanitizeStorageEnvelope(data);
  writeStorageFile(sanitized);
  return sanitized;
}

export async function runSerializedKanbanMutation(mutator) {
  persistKanbanLock = persistKanbanLock.then(async () => {
    const current = await readKanbanStorage();
    const result = await mutator(current);
    if (result && typeof result === 'object') {
      await writeKanbanStorage(result);
      return result;
    }
    await writeKanbanStorage(current);
    return current;
  });
  return persistKanbanLock;
}

export function getDefaultBoard() {
  return createDefaultBoard();
}

export const KANBAN_STORAGE_FILE = STORAGE_FILE;
