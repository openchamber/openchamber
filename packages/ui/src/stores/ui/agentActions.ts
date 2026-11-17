import type { UIStoreSlice } from './types';

export const createAgentActions: UIStoreSlice<
  | 'setAgentControlToolEnabled'
  | 'setAgentScheduleToolEnabled'
  | 'setAgentWebToolEnabled'
  | 'setMessageSearchEnabled'
  | 'setMessageSearchReasoningEnabled'
  | 'setBrowserProvider'
  | 'setAgentMemoryToolEnabled'
  | 'setAgentKnowledgeToolEnabled'
  | 'setIsolatedSpacesEnabled'
  | 'setPermissionDefaultMode'
  | 'setAgentNotifyToolEnabled'
  | 'setAgentUsageToolEnabled'
  | 'setAgentTerminalToolEnabled'
  | 'setAgentImageToolEnabled'
  | 'setAgentImageModel'
  | 'setAgentMemoryDreamingEnabled'
  | 'setAgentMemoryDreamingModel'
  | 'setAgentMemoryDreamingVariant'
  | 'setAgentRenderToolEnabled'
  | 'setAgentSecretToolEnabled'
  | 'setAgentWorkflowToolEnabled'
  | 'setAgentMemoryFeatureAvailable'
  | 'setAgentWorkflowFeatureAvailable'
  | 'setRoutingFeatureAvailable'
  | 'setOverviewFeatureAvailable'
  | 'markAgentMemoryViewed'
  | 'setProjectContextTab'
  | 'openProjectKnowledgePlan'
  | 'clearProjectKnowledgePlanRequest'
> = (set, get) => ({
  setAgentControlToolEnabled: (value) => {
    set({ agentControlToolEnabled: value });
  },

  setAgentScheduleToolEnabled: (value) => {
    set({ agentScheduleToolEnabled: value });
  },

  setAgentWebToolEnabled: (value) => {
    set({ agentWebToolEnabled: value });
  },

  setMessageSearchEnabled: (value) => {
    set({ messageSearchEnabled: value });
  },

  setMessageSearchReasoningEnabled: (value) => {
    set({ messageSearchReasoningEnabled: value });
  },

  setBrowserProvider: (value) => {
    set({ browserProvider: value });
  },

  setAgentMemoryToolEnabled: (value) => {
    set({ agentMemoryToolEnabled: value });
  },

  setAgentKnowledgeToolEnabled: (value) => {
    set({ agentKnowledgeToolEnabled: value });
  },

  setIsolatedSpacesEnabled: (value) => {
    set({ isolatedSpacesEnabled: value });
  },

  setPermissionDefaultMode: (value) => {
    set({ permissionDefaultMode: value });
  },

  setAgentNotifyToolEnabled: (value) => {
    set({ agentNotifyToolEnabled: value });
  },

  setAgentUsageToolEnabled: (value) => {
    set({ agentUsageToolEnabled: value });
  },

  setAgentTerminalToolEnabled: (value) => {
    set({ agentTerminalToolEnabled: value });
  },

  setAgentImageToolEnabled: (value) => {
    set({ agentImageToolEnabled: value });
  },

  setAgentImageModel: (value) => {
    set({ agentImageModel: value });
  },

  setAgentMemoryDreamingEnabled: (value) => {
    set({ agentMemoryDreamingEnabled: value });
  },

  setAgentMemoryDreamingModel: (value) => {
    set({ agentMemoryDreamingModel: value });
  },

  setAgentMemoryDreamingVariant: (value) => {
    set({ agentMemoryDreamingVariant: value });
  },

  setAgentRenderToolEnabled: (value) => {
    set({ agentRenderToolEnabled: value });
  },

  setAgentSecretToolEnabled: (value) => {
    set({ agentSecretToolEnabled: value });
  },

  setAgentWorkflowToolEnabled: (value) => {
    set({ agentWorkflowToolEnabled: value });
    if (value) return;
    for (const [directory, panel] of Object.entries(get().contextPanelByDirectory)) {
      const workflowTabIds = panel.tabs.filter((tab) => tab.mode === 'workflows').map((tab) => tab.id);
      if (workflowTabIds.length > 0) get().closeContextPanelTabs(directory, workflowTabIds);
    }
  },

  setAgentMemoryFeatureAvailable: (value) => {
    set({ agentMemoryFeatureAvailable: value });
  },

  setAgentWorkflowFeatureAvailable: (value) => {
    set({ agentWorkflowFeatureAvailable: value });
  },

  setRoutingFeatureAvailable: (value) => {
    set({ routingFeatureAvailable: value });
  },

  setOverviewFeatureAvailable: (value) => {
    set(value ? { overviewFeatureAvailable: true } : { overviewFeatureAvailable: false, isOverviewOpen: false });
  },

  markAgentMemoryViewed: (key, viewedAt) => {
    set((state) => ({
      agentMemoryViewedAt: viewedAt > (state.agentMemoryViewedAt[key] ?? 0)
        ? { ...state.agentMemoryViewedAt, [key]: viewedAt }
        : state.agentMemoryViewedAt,
    }));
  },

  setProjectContextTab: (value) => {
    set({ projectContextTab: value });
  },

  openProjectKnowledgePlan: (directory, projectContextId, planId) => {
    set({ projectContextTab: 'plans', projectKnowledgePlanRequest: { projectContextId, planId } });
    get().openContextPanelTab(directory, { mode: 'notes' });
  },

  clearProjectKnowledgePlanRequest: () => {
    set({ projectKnowledgePlanRequest: null });
  },
});
