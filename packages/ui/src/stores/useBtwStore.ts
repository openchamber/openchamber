import { create } from 'zustand';

/**
 * State for the `/btw` peek panel.
 *
 * The panel is a transient sheet that shows a fork of the main session
 * (`/btw <question>`): the fork inherits the full conversation context, the
 * question becomes its first new message, and closing the panel destroys the
 * fork, so the main conversation stays untouched. The create/send/destroy
 * flows live in `@/lib/btw`.
 */

type BtwPanelIdentity = {
  sessionId: string | null;
  directory: string | null;
  title: string | null;
  /**
   * Fork creation time (server epoch ms). The panel shows only the messages
   * created at or after this boundary — the fork's own tail — instead of the
   * entire inherited history.
   */
  forkedAtMs: number | null;
};

type BtwStore = {
  panel: BtwPanelIdentity;
  openBtw: (sessionId: string, directory: string, title: string | null, forkedAtMs: number | null) => void;
  closeBtw: () => void;
};

export const useBtwStore = create<BtwStore>()((set) => ({
  panel: { sessionId: null, directory: null, title: null, forkedAtMs: null },
  openBtw: (sessionId, directory, title, forkedAtMs) =>
    set({ panel: { sessionId, directory, title, forkedAtMs } }),
  closeBtw: () =>
    set({ panel: { sessionId: null, directory: null, title: null, forkedAtMs: null } }),
}));
