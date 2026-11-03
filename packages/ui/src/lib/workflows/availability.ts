type WorkflowFlags = { agentWorkflowFeatureAvailable: boolean; agentWorkflowToolEnabled: boolean };

/**
 * Whether the app shows workflows: an OpenChamber server backs them (not VS
 * Code) and the user turned the workflow tool on. Off, the Workflows panel,
 * its rail entry and work-status section are gone and no runs are read, like
 * memory's tab; the Settings row stays, keyed on availability alone.
 */
export const selectWorkflowsShown = (state: WorkflowFlags): boolean => (
  state.agentWorkflowFeatureAvailable && state.agentWorkflowToolEnabled
);
