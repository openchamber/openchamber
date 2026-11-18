import type { createMessageSearchRuntime } from './runtime.js';

type MessageRole = 'user' | 'assistant' | 'reasoning';
export type SearchLifecycle = 'active' | 'archived' | 'all';
export type SearchOrder = 'asc' | 'desc';

export interface MessageCursor {
  createdAt: number;
  id: string;
}

export interface SessionCursor {
  createdAt: number;
  sessionId: string;
}

export interface SearchOptions {
  query: string;
  sessionId?: string | null;
  directories?: string[];
  role?: MessageRole | null;
  includeReasoning?: boolean;
  lifecycle?: SearchLifecycle;
  before?: MessageCursor | null;
  limit: number;
  order?: SearchOrder;
}

export interface SessionSearchOptions extends Omit<SearchOptions, 'sessionId' | 'before' | 'order'> {
  before?: SessionCursor | null;
  exclude?: string[];
}

type SearchRuntime = ReturnType<typeof createMessageSearchRuntime>;

export interface MessageSearchRouteRuntime extends Pick<SearchRuntime, 'status' | 'deleteIndex'> {
  search: (options: SearchOptions) => ReturnType<SearchRuntime['search']>;
  searchSessions: (options: SessionSearchOptions) => ReturnType<SearchRuntime['searchSessions']>;
}
