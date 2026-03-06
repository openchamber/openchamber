import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { ModelProfile, ModelProfilesState, AgentModelMapping, CategoryModelMapping } from "@/types/profiles";
import { useAgentsStore, reloadOpenCodeConfiguration } from "./useAgentsStore";
import { useConfigStore } from "./useConfigStore";
import { useOhMyOpencodeStore } from "./useOhMyOpencodeStore";

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

      createProfile: async (name: string, agentModels: AgentModelMapping, categoryModels?: CategoryModelMapping, omoAgentModels?: AgentModelMapping) => {
        set({ isLoading: true });
        try {
          const body: Record<string, unknown> = { name, agentModels };
          if (categoryModels && Object.keys(categoryModels).length > 0) {
            body.categoryModels = categoryModels;
          }
          if (omoAgentModels && Object.keys(omoAgentModels).length > 0) {
            body.omoAgentModels = omoAgentModels;
          }
          const response = await fetch("/api/config/profiles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
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
        const omoState = useOhMyOpencodeStore.getState();

        // Exclude omo agents from agentModels — captured separately in omoAgentModels
        const omoAgentNamesSet = new Set(
          omoState.installed && omoState.agents ? Object.keys(omoState.agents) : [],
        );

        const agentModels: AgentModelMapping = {};
        for (const agent of agents) {
          if (omoAgentNamesSet.has(agent.name)) continue;
          const selection = agentModelSelections[agent.name];
          if (selection?.providerId && selection?.modelId) {
            agentModels[agent.name] = `${selection.providerId}/${selection.modelId}`;
          }
        }

        // Capture oh-my-opencode category models if installed
        let categoryModels: CategoryModelMapping | undefined;
        if (omoState.installed && omoState.categories) {
          categoryModels = {};
          for (const [catName, catConfig] of Object.entries(omoState.categories)) {
            if (catConfig?.model) {
              categoryModels[catName] = catConfig.model;
            }
          }
          if (Object.keys(categoryModels).length === 0) {
            categoryModels = undefined;
          }
        }

        // Capture oh-my-opencode agent models if installed
        let omoAgentModels: AgentModelMapping | undefined;
        if (omoState.installed && omoState.agents) {
          omoAgentModels = {};
          for (const [agentName, agentConfig] of Object.entries(omoState.agents)) {
            if (agentConfig?.model) {
              omoAgentModels[agentName] = agentConfig.model;
            }
          }
          if (Object.keys(omoAgentModels).length === 0) {
            omoAgentModels = undefined;
          }
        }

        return get().createProfile(name, agentModels, categoryModels, omoAgentModels);
      },

      updateProfile: async (id: string, updates: { name?: string; agentModels?: AgentModelMapping; categoryModels?: CategoryModelMapping; omoAgentModels?: AgentModelMapping }) => {
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
          // Build a full payload for each agent so that built-in agents get a
          // complete .md file (prompt, description, mode, etc.) instead of only
          // the model field.  Permission is excluded because the SDK runtime
          // type (PermissionRuleset) differs from the config type
          // (PermissionConfig) and should only be changed via Agent Settings.
          const currentAgents = useAgentsStore.getState().agents;
          const agentsPayload: Record<string, Record<string, unknown>> = {};
          for (const [agentName, modelString] of Object.entries(profile.agentModels)) {
            const agent = currentAgents.find((a) => a.name === agentName);
            const updates: Record<string, unknown> = { model: modelString };
            if (agent) {
              if (agent.prompt) updates.prompt = agent.prompt;
              if (agent.description) updates.description = agent.description;
              if (agent.mode) updates.mode = agent.mode;
              if (agent.temperature !== undefined) updates.temperature = agent.temperature;
              if (agent.topP !== undefined) updates.top_p = agent.topP;
            }
            agentsPayload[agentName] = updates;
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

          // Apply oh-my-opencode category models if present
          if (profile.categoryModels && Object.keys(profile.categoryModels).length > 0) {
            const omoState = useOhMyOpencodeStore.getState();
            if (omoState.installed) {
              // Merge profile category models with existing oh-my-opencode categories
              const existingCategories = omoState.categories || {};
              const updatedCategories: Record<string, Record<string, unknown>> = {};
              // Preserve all existing category entries
              for (const [catName, catConfig] of Object.entries(existingCategories)) {
                updatedCategories[catName] = { ...catConfig };
              }
              // Override model for categories specified in the profile
              for (const [catName, modelString] of Object.entries(profile.categoryModels)) {
                if (!updatedCategories[catName]) {
                  updatedCategories[catName] = {};
                }
                updatedCategories[catName].model = modelString;
              }
              try {
                const catResponse = await fetch("/api/config/oh-my-opencode/categories", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ categories: updatedCategories }),
                });
                if (!catResponse.ok) {
                  console.warn("Failed to apply oh-my-opencode categories");
                } else {
                  // Reload oh-my-opencode state
                  await omoState.load();
                }
              } catch {
                console.warn("Failed to apply oh-my-opencode categories");
              }
            }
          }

          // Apply oh-my-opencode agent models if present
          if (profile.omoAgentModels && Object.keys(profile.omoAgentModels).length > 0) {
            const omoStateForAgents = useOhMyOpencodeStore.getState();
            if (omoStateForAgents.installed) {
              // Merge profile agent models with existing oh-my-opencode agents
              const existingAgents = omoStateForAgents.agents || {};
              const updatedAgents: Record<string, Record<string, unknown>> = {};
              // Preserve all existing agent entries
              for (const [agentName, agentConfig] of Object.entries(existingAgents)) {
                updatedAgents[agentName] = { ...agentConfig };
              }
              // Override model for agents specified in the profile
              for (const [agentName, modelString] of Object.entries(profile.omoAgentModels)) {
                if (!updatedAgents[agentName]) {
                  updatedAgents[agentName] = {};
                }
                updatedAgents[agentName].model = modelString;
              }
              try {
                const agentResponse = await fetch("/api/config/oh-my-opencode/agents", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ agents: updatedAgents }),
                });
                if (!agentResponse.ok) {
                  console.warn("Failed to apply oh-my-opencode agents");
                } else {
                  // Reload oh-my-opencode state
                  await omoStateForAgents.load();
                }
              } catch {
                console.warn("Failed to apply oh-my-opencode agents");
              }
            }
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
