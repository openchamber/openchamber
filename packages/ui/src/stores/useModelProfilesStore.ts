import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { ModelProfile, ModelProfilesState, AgentModelMapping } from "@/types/profiles";
import { useAgentsStore, reloadOpenCodeConfiguration } from "./useAgentsStore";
import { useConfigStore } from "./useConfigStore";

export const useModelProfilesStore = create<ModelProfilesState>()(
  devtools(
    (set, get) => ({
      profiles: [],
      selectedProfileId: null,
      isLoading: false,
      error: null,

      loadProfiles: async () => {
        set({ isLoading: true });
        try {
          const response = await fetch("/api/config/profiles");
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            const message = payload?.error || "Failed to load profiles";
            throw new Error(message);
          }
          const profiles: ModelProfile[] = Array.isArray(payload?.profiles) ? payload.profiles : [];
          set({ profiles, isLoading: false, error: null });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to load profiles";
          set({ error: message, isLoading: false });
        }
      },

      createProfile: async (name: string, agentModels: AgentModelMapping) => {
        set({ isLoading: true });
        try {
          const response = await fetch("/api/config/profiles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, agentModels }),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            const message = payload?.error || "Failed to create profile";
            throw new Error(message);
          }
          const created: ModelProfile = payload.profile;
          set({ isLoading: false, error: null });
          await get().loadProfiles();
          set({ selectedProfileId: created.id });
          return created;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to create profile";
          set({ error: message, isLoading: false });
          return null;
        }
      },

      createFromCurrent: async (name: string) => {
        const agents = useAgentsStore.getState().agents;
        const agentModelSelections = useConfigStore.getState().agentModelSelections;

        const agentModels: AgentModelMapping = {};
        for (const agent of agents) {
          const selection = agentModelSelections[agent.name];
          if (selection?.providerId && selection?.modelId) {
            agentModels[agent.name] = `${selection.providerId}/${selection.modelId}`;
          }
        }

        return get().createProfile(name, agentModels);
      },

      updateProfile: async (id: string, updates: { name?: string; agentModels?: AgentModelMapping }) => {
        set({ isLoading: true });
        try {
          const response = await fetch(`/api/config/profiles/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updates),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            const message = payload?.error || "Failed to update profile";
            throw new Error(message);
          }
          set({ isLoading: false, error: null });
          await get().loadProfiles();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to update profile";
          set({ error: message, isLoading: false });
        }
      },

      deleteProfile: async (id: string) => {
        set({ isLoading: true });
        try {
          const response = await fetch(`/api/config/profiles/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            const message = payload?.error || "Failed to delete profile";
            throw new Error(message);
          }
          set({ isLoading: false, error: null });
          if (get().selectedProfileId === id) {
            get().selectProfile(null);
          }
          await get().loadProfiles();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to delete profile";
          set({ error: message, isLoading: false });
        }
      },

      applyProfile: async (id: string) => {
        set({ isLoading: true });
        try {
          const profile = get().profiles.find((p) => p.id === id);
          if (!profile) {
            throw new Error(`Profile with id "${id}" not found`);
          }

          const agentsPayload: Record<string, { model: string }> = {};
          for (const [agentName, modelString] of Object.entries(profile.agentModels)) {
            agentsPayload[agentName] = { model: modelString };
          }

          const response = await fetch("/api/config/agents/batch-update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agents: agentsPayload }),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            const message = payload?.error || "Failed to apply profile";
            throw new Error(message);
          }
          if (Array.isArray(payload?.failed) && payload.failed.length > 0) {
            const names = payload.failed.map((f: { name: string }) => f.name).join(", ");
            throw new Error(`Some agents could not be updated: ${names}`);
          }
          set({ isLoading: false, error: null });
          await reloadOpenCodeConfiguration();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to apply profile";
          set({ error: message, isLoading: false });
        }
      },

      selectProfile: (id: string | null) => {
        set({ selectedProfileId: id });
      },
    }),
    {
      name: "model-profiles-store",
    },
  ),
);
