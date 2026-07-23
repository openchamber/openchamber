import { create } from 'zustand';

export type PendingDiscordMessage = {
  messageId: string;
  text: string;
  from: { username?: string | null; firstName?: string | null } | null;
  timestamp: number;
  channelId?: string;
  threadId?: string;
};

type PendingDiscordState = {
  /** Pending Discord messages keyed by sessionId. Non-null while a Discord
   *  supersede is in flight — the UI renders this as an optimistic user message.
   *  Cleared when the real message arrives via SSE. */
  pending: Record<string, PendingDiscordMessage | null>;
  setPending: (sessionId: string, msg: PendingDiscordMessage) => void;
  clearPending: (sessionId: string) => void;
};

export const usePendingDiscordStore = create<PendingDiscordState>((set) => ({
  pending: {},
  setPending: (sessionId, msg) =>
    set((state) => ({
      pending: { ...state.pending, [sessionId]: msg },
    })),
  clearPending: (sessionId) =>
    set((state) => {
      const next = { ...state.pending };
      delete next[sessionId];
      return { pending: next };
    }),
}));
