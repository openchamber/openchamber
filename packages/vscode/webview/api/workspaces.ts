import type {
  WorkspaceApplyResult,
  WorkspaceCompatibilityResult,
  WorkspaceConfigureResult,
  WorkspaceExportResult,
  WorkspaceProviderValidationResult,
  WorkspaceSecurityAPI,
} from '@openchamber/ui/lib/api/types';

const unsupported = 'Secure Workspaces are not supported in the VS Code runtime.';
const unsupportedCompatibility: WorkspaceCompatibilityResult = {
  configured: false,
  active: false,
  supported: false,
  adapterKinds: [],
  status: 'not-configured',
  error: unsupported,
};

export const createVSCodeWorkspaceSecurityAPI = (): WorkspaceSecurityAPI => ({
  async reauthenticate() {
    throw new Error(unsupported);
  },
  async validateProvider(): Promise<WorkspaceProviderValidationResult> {
    return { available: false, error: unsupported };
  },
  async compatibility(): Promise<WorkspaceCompatibilityResult> {
    return unsupportedCompatibility;
  },
  async updateSettings(): Promise<WorkspaceConfigureResult> {
    return { configured: false, enabled: false, active: false, compatibility: unsupportedCompatibility };
  },
  async create() {
    throw new Error(unsupported);
  },
  async cleanup() {
    throw new Error(unsupported);
  },
  async reconcileWorkspace() {
    throw new Error(unsupported);
  },
  async exportWorkspace(): Promise<WorkspaceExportResult> {
    throw new Error(unsupported);
  },
  async downloadArtifact() {
    throw new Error(unsupported);
  },
  async discardArtifact() {
    throw new Error(unsupported);
  },
  async applyExport(input: { checkOnly?: boolean }): Promise<WorkspaceApplyResult> {
    return { applied: false, checkOnly: input.checkOnly !== false, error: unsupported };
  },
  async createHandoffDraft() {
    throw new Error(unsupported);
  },
  async commitHandoff() {
    throw new Error(unsupported);
  },
  async inspectHandoff() {
    throw new Error(unsupported);
  },
  async cleanupHandoffTarget() {
    throw new Error(unsupported);
  },
});
