type WorkflowFlags = { agentWorkflowFeatureAvailable: boolean; agentWorkflowToolEnabled: boolean };

export const selectWorkflowsShown = (state: WorkflowFlags): boolean => (
  state.agentWorkflowFeatureAvailable && state.agentWorkflowToolEnabled
);
