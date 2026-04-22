import { create } from 'zustand';

export interface Workspace {
  id: string;
  github_org_login: string;
  github_installation_id: number;
  display_name: string;
  role: string;
}

export interface WorkspaceStore {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  loading: boolean;
  error: string | null;

  setWorkspaces: (workspaces: Workspace[]) => void;
  setActiveWorkspace: (id: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  workspaces: [],
  activeWorkspaceId: null,
  loading: false,
  error: null,

  setWorkspaces: (workspaces) => set({ workspaces }),
  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
