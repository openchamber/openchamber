
import type { BoardCard } from '@/types/kanban';
import type {
  KanbanBoardResponse,
  KanbanMutationResponse,
  KanbanCreateColumnPayload,
  KanbanRenameColumnPayload,
  KanbanCreateCardPayload,
  KanbanMoveCardPayload,
} from '@/lib/api/types';

declare global {
  interface Window {
    __OPENCHAMBER_DESKTOP_SERVER__?: {
      origin: string;
      opencodePort: number | null;
      apiPrefix: string;
      cliAvailable: boolean;
    };
  }
}

const resolveBaseOrigin = (): string => {
  if (typeof window === 'undefined') {
    return '';
  }
  const desktopOrigin = window.__OPENCHAMBER_DESKTOP_SERVER__?.origin;
  if (desktopOrigin) {
    return desktopOrigin;
  }
  return window.location.origin;
};

const API_BASE = '/api/kanban';

function buildUrl(
  path: string,
  directory: string | null | undefined,
  params?: Record<string, string | number | boolean | undefined>
): string {
  const url = new URL(path, resolveBaseOrigin());
  if (directory) {
    url.searchParams.set('directory', directory);
  }

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((error as { error?: string }).error || 'Request failed');
  }
  return response.json() as Promise<T>;
}

export async function getBoard(directory: string): Promise<KanbanBoardResponse> {
  const response = await fetch(buildUrl(`${API_BASE}/board`, directory));
  return handleResponse<KanbanBoardResponse>(response);
}

export async function createColumn(
  directory: string,
  name: string,
  afterColumnId?: string
): Promise<KanbanMutationResponse> {
  const body: KanbanCreateColumnPayload = { name };
  if (afterColumnId !== undefined) {
    body.afterColumnId = afterColumnId;
  }

  const response = await fetch(buildUrl(`${API_BASE}/columns`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse<KanbanMutationResponse>(response);
}

export async function renameColumn(
  directory: string,
  columnId: string,
  name: string
): Promise<KanbanMutationResponse> {
  const body: KanbanRenameColumnPayload = { name };
  const response = await fetch(buildUrl(`${API_BASE}/columns/${columnId}`, directory), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse<KanbanMutationResponse>(response);
}

export async function deleteColumn(directory: string, columnId: string): Promise<KanbanMutationResponse> {
  const response = await fetch(buildUrl(`${API_BASE}/columns/${columnId}`, directory), {
    method: 'DELETE',
  });
  return handleResponse<KanbanMutationResponse>(response);
}

export async function createCard(
  directory: string,
  columnId: string,
  title: string,
  description: string,
  worktreeId: string
): Promise<KanbanMutationResponse> {
  const body: KanbanCreateCardPayload = { columnId, title, description, worktreeId };
  const response = await fetch(buildUrl(`${API_BASE}/cards`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse<KanbanMutationResponse>(response);
}

export async function updateCard(
  directory: string,
  cardId: string,
  updates: Partial<BoardCard>
): Promise<KanbanMutationResponse> {
  const response = await fetch(buildUrl(`${API_BASE}/cards/${cardId}`, directory), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  return handleResponse<KanbanMutationResponse>(response);
}

export async function deleteCard(directory: string, cardId: string): Promise<KanbanMutationResponse> {
  const response = await fetch(buildUrl(`${API_BASE}/cards/${cardId}`, directory), {
    method: 'DELETE',
  });
  return handleResponse<KanbanMutationResponse>(response);
}

export async function moveCard(
  directory: string,
  cardId: string,
  toColumnId: string,
  toOrder?: number
): Promise<KanbanMutationResponse> {
  const body: KanbanMoveCardPayload = { toColumnId };
  if (toOrder !== undefined) {
    body.toOrder = toOrder;
  }

  const response = await fetch(buildUrl(`${API_BASE}/cards/${cardId}/move`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse<KanbanMutationResponse>(response);
}
