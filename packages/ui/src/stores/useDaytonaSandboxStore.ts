import { create } from "zustand";

export interface SandboxInfo {
  sandboxId: string;
  sessionId: string;
  status: 'creating' | 'running' | 'stopping' | 'destroyed' | 'error' | 'timed-out';
  openCodeUrl: string | null;
  createdAt: string;
  error?: string;
}

interface DaytonaSandboxState {
  sandboxMode: boolean;
  sandboxes: Map<string, SandboxInfo>;

  setSandboxMode: (enabled: boolean) => void;
  setSandboxStatus: (sessionId: string, info: Partial<SandboxInfo>) => void;
  removeSandbox: (sessionId: string) => void;
  getSandboxForSession: (sessionId: string) => SandboxInfo | undefined;
}

export const useDaytonaSandboxStore = create<DaytonaSandboxState>()((set, get) => ({
  sandboxMode: false,
  sandboxes: new Map(),

  setSandboxMode: (enabled: boolean) => {
    set({ sandboxMode: enabled });
    if (typeof window !== 'undefined') {
      localStorage.setItem('daytona.sandboxMode', String(enabled));
    }
  },

  setSandboxStatus: (sessionId: string, info: Partial<SandboxInfo>) => {
    set((state) => {
      const next = new Map(state.sandboxes);
      const existing = next.get(sessionId);
      if (existing) {
        next.set(sessionId, { ...existing, ...info });
      } else {
        next.set(sessionId, {
          sandboxId: info.sandboxId ?? '',
          sessionId,
          status: info.status ?? 'creating',
          openCodeUrl: info.openCodeUrl ?? null,
          createdAt: info.createdAt ?? new Date().toISOString(),
          error: info.error,
        });
      }
      return { sandboxes: next };
    });
  },

  removeSandbox: (sessionId: string) => {
    set((state) => {
      const next = new Map(state.sandboxes);
      next.delete(sessionId);
      return { sandboxes: next };
    });
  },

  getSandboxForSession: (sessionId: string) => {
    return get().sandboxes.get(sessionId);
  },
}));

// Hydrate sandboxMode from localStorage on module load
if (typeof window !== 'undefined') {
  const stored = localStorage.getItem('daytona.sandboxMode');
  if (stored === 'true') {
    useDaytonaSandboxStore.setState({ sandboxMode: true });
  }
}
