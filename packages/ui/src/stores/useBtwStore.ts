import { create } from 'zustand';

export type BtwFailureReason = 'empty' | 'timeout' | 'unsupported' | 'session-missing' | 'error';

export type BtwStatus = 'compose' | 'running' | 'answered' | 'failed';

/**
 * One `/btw` side question. It lives in memory only: closing the dialog drops
 * it, and a page reload starts with no side-question state.
 */
export type BtwRequest = {
  id: string;
  parentSessionId: string;
  ownerKey: string;
  directory: string | null;
  runtimeKey: string;
  question: string;
  draft: string;
  status: BtwStatus;
  answer?: string;
  failure?: {
    reason: BtwFailureReason;
    message?: string;
  };
  startedAt?: number;
  completedAt?: number;
};

type BtwStore = {
  byParent: Record<string, BtwRequest | undefined>;
  /**
   * Opens the question field without sending anything. A running request is
   * left alone so a second `/btw` cannot start a competing model call.
   */
  openComposer: (parentSessionId: string, ownerKey: string, directory: string | null, initialQuestion?: string) => boolean;
  setDraft: (parentSessionId: string, draft: string) => void;
  begin: (
    parentSessionId: string,
    requestId: string,
    ownerKey: string,
    question: string,
    directory: string | null,
    runtimeKey: string,
  ) => boolean;
  succeed: (parentSessionId: string, requestId: string, answer: string, completedAt: number) => void;
  fail: (
    parentSessionId: string,
    requestId: string,
    reason: BtwFailureReason,
    message?: string,
  ) => void;
  dismiss: (parentSessionId: string) => BtwRequest | null;
  clear: (parentSessionId: string) => void;
};

const newRequestId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `btw-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const composeRequest = (
  parentSessionId: string,
  ownerKey: string,
  directory: string | null,
  initialQuestion: string | undefined,
): BtwRequest => {
  const question = initialQuestion?.trim() ?? '';
  return {
    id: newRequestId(),
    parentSessionId,
    ownerKey,
    directory,
    runtimeKey: '',
    question,
    draft: question,
    status: 'compose',
  };
};

export const useBtwStore = create<BtwStore>()((set, get) => ({
  byParent: {},

  openComposer: (parentSessionId, ownerKey, directory, initialQuestion) => {
    const existing = get().byParent[parentSessionId];
    if (existing?.status === 'running') return false;
    set((state) => ({
      byParent: {
        ...state.byParent,
        [parentSessionId]: composeRequest(parentSessionId, ownerKey, directory, initialQuestion),
      },
    }));
    return true;
  },

  setDraft: (parentSessionId, draft) =>
    set((state) => {
      const request = state.byParent[parentSessionId];
      if (!request || request.status !== 'compose') return state;
      return {
        byParent: {
          ...state.byParent,
          [parentSessionId]: { ...request, draft },
        },
      };
    }),

  begin: (parentSessionId, requestId, ownerKey, question, directory, runtimeKey) => {
    const trimmed = question.trim();
    if (!trimmed) return false;
    const existing = get().byParent[parentSessionId];
    if (existing?.status === 'running') return false;
    set((state) => ({
      byParent: {
        ...state.byParent,
        [parentSessionId]: {
          id: requestId,
          parentSessionId,
          ownerKey,
          directory,
          runtimeKey,
          question: trimmed,
          draft: trimmed,
          status: 'running',
          startedAt: Date.now(),
        },
      },
    }));
    return true;
  },

  succeed: (parentSessionId, requestId, answer, completedAt) =>
    set((state) => {
      const request = state.byParent[parentSessionId];
      if (!request || request.id !== requestId || request.status !== 'running') return state;
      return {
        byParent: {
          ...state.byParent,
          [parentSessionId]: {
            ...request,
            status: 'answered',
            answer,
            completedAt,
          },
        },
      };
    }),

  fail: (parentSessionId, requestId, reason, message) =>
    set((state) => {
      const request = state.byParent[parentSessionId];
      if (!request || request.id !== requestId || request.status !== 'running') return state;
      return {
        byParent: {
          ...state.byParent,
          [parentSessionId]: {
            ...request,
            status: 'failed',
            failure: { reason, message },
            completedAt: Date.now(),
          },
        },
      };
    }),

  dismiss: (parentSessionId) => {
    const request = get().byParent[parentSessionId] ?? null;
    if (!request) return null;
    set((state) => {
      const byParent = { ...state.byParent };
      delete byParent[parentSessionId];
      return { byParent };
    });
    return request;
  },

  clear: (parentSessionId) =>
    set((state) => {
      if (!(parentSessionId in state.byParent)) return state;
      const byParent = { ...state.byParent };
      delete byParent[parentSessionId];
      return { byParent };
    }),
}));
