import { create } from 'zustand';
import { runtimeFetch } from '@/lib/runtime-fetch';

interface LinearViewer {
  id: string;
  name: string | null;
  email: string | null;
}

interface LinearOrganization {
  id: string;
  name: string | null;
  urlKey: string | null;
}

interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

interface LinearTeamMapping {
  teamId: string;
  teamKey: string | null;
  teamName: string | null;
  projectId: string;
}

interface LinearIntegrationSettings {
  defaultProjectId: string | null;
  teamMappings: LinearTeamMapping[];
  triggerLabel: string;
  autoStartEnabled: boolean;
  postStatusUpdates: boolean;
  linkBaseUrl: string | null;
}

export type LinearLinkStatus = 'started' | 'completed' | 'failed' | 'attention';

export interface LinearSessionLink {
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueUrl: string | null;
  teamKey: string | null;
  sessionId: string;
  directory: string | null;
  projectId: string | null;
  createdAt: number;
  lastStatus: LinearLinkStatus;
}

interface LinearStartResult {
  issue: { id: string; identifier: string | null; title: string | null; url: string | null };
  sessionId: string;
  directory: string | null;
  sessionUrl: string;
  promptDispatched: boolean;
}

interface LinearStatusResponse {
  connected: boolean;
  viewer: LinearViewer | null;
  organization: LinearOrganization | null;
  settings: LinearIntegrationSettings;
}

interface LinearIntegrationState {
  hydrated: boolean;
  connected: boolean;
  viewer: LinearViewer | null;
  organization: LinearOrganization | null;
  settings: LinearIntegrationSettings | null;
  teams: LinearTeam[];
  links: LinearSessionLink[];
  busy: boolean;
  error: string | null;

  refreshStatus: () => Promise<void>;
  connect: (apiKey: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
  updateSettings: (partial: Partial<LinearIntegrationSettings>) => Promise<void>;
  fetchTeams: () => Promise<void>;
  fetchLinks: () => Promise<void>;
  startFromIssue: (issue: string) => Promise<LinearStartResult>;
  removeLink: (issueId: string) => Promise<void>;
  clearError: () => void;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await runtimeFetch(url, init);
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  if (body == null) throw new Error('Empty response');
  return body;
}

function postJson<T>(url: string, body?: unknown): Promise<T> {
  return requestJson<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

/**
 * Linear integration state. The server is the source of truth (the API key
 * and settings live in the server's config file) — nothing here is persisted
 * client-side; the section refreshes status on mount.
 */
export const useLinearIntegrationStore = create<LinearIntegrationState>((set, get) => ({
  hydrated: false,
  connected: false,
  viewer: null,
  organization: null,
  settings: null,
  teams: [],
  links: [],
  busy: false,
  error: null,

  clearError: () => set({ error: null }),

  refreshStatus: async () => {
    try {
      const status = await requestJson<LinearStatusResponse>('/api/linear/status');
      set({
        hydrated: true,
        connected: status.connected,
        viewer: status.viewer,
        organization: status.organization,
        settings: status.settings,
      });
    } catch {
      // Leave existing state; the section keeps its last known view. A fetch
      // failure must not masquerade as "disconnected".
      set({ hydrated: true });
    }
  },

  connect: async (apiKey: string) => {
    set({ busy: true, error: null });
    try {
      const status = await postJson<LinearStatusResponse>('/api/linear/connect', { apiKey });
      set({
        busy: false,
        connected: status.connected,
        viewer: status.viewer,
        organization: status.organization,
        settings: status.settings,
      });
      void get().fetchTeams();
      void get().fetchLinks();
      return true;
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  disconnect: async () => {
    set({ busy: true, error: null });
    try {
      const status = await postJson<LinearStatusResponse>('/api/linear/disconnect');
      set({
        busy: false,
        connected: status.connected,
        viewer: status.viewer,
        organization: status.organization,
        settings: status.settings,
        teams: [],
      });
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  updateSettings: async (partial) => {
    const previous = get().settings;
    // Optimistic apply so selects/switches feel instant; roll back on failure.
    if (previous) set({ settings: { ...previous, ...partial } });
    try {
      const result = await requestJson<{ settings: LinearIntegrationSettings }>(
        '/api/linear/settings',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(partial),
        },
      );
      set({ settings: result.settings });
    } catch (error) {
      set({
        settings: previous,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  fetchTeams: async () => {
    try {
      const result = await requestJson<{ teams: LinearTeam[] }>('/api/linear/teams');
      set({ teams: result.teams });
    } catch {
      // Team list is an enhancement for mapping UI; keep the last known list.
    }
  },

  fetchLinks: async () => {
    try {
      const result = await requestJson<{ links: LinearSessionLink[] }>('/api/linear/links');
      set({ links: result.links });
    } catch {
      // Keep the last known list rather than clearing it on a failed fetch.
    }
  },

  startFromIssue: async (issue: string) => {
    set({ busy: true, error: null });
    try {
      const result = await postJson<LinearStartResult>('/api/linear/issues/start', { issue });
      set({ busy: false });
      void get().fetchLinks();
      return result;
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  removeLink: async (issueId: string) => {
    try {
      await requestJson<{ removed: boolean }>(`/api/linear/links/${encodeURIComponent(issueId)}`, {
        method: 'DELETE',
      });
    } finally {
      void get().fetchLinks();
    }
  },
}));
