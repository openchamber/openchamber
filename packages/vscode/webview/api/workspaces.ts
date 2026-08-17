import type {
  WorkspaceApplyResult,
  WorkspaceCompatibilityResult,
  WorkspaceConfigureResult,
  WorkspaceExportResult,
  WorkspaceProviderEnvironment,
  WorkspaceProviderKind,
  WorkspaceProviderValidationResult,
  WorkspaceReadinessResult,
  WorkspaceSecurityAPI,
  WorkspaceSetupResult,
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
  async startSession() {
    throw Object.assign(new Error('Secure Workspace sessions are not supported in VS Code'), { code: 'WORKSPACE_UNSUPPORTED' });
  },
  async validateProvider(): Promise<WorkspaceProviderValidationResult> {
    return { available: false, error: unsupported };
  },
  async setupProvider(input: { provider: WorkspaceProviderKind; action: 'create-namespace' | 'check-isolation' }): Promise<WorkspaceSetupResult> {
    return { provider: input.provider, action: input.action, diagnostics: [unsupported] };
  },
  async providerEnvironment(input: { provider: WorkspaceProviderKind }): Promise<WorkspaceProviderEnvironment> {
    return { provider: input.provider, contexts: [], currentContext: null };
  },
  async policyState(): Promise<{ mismatched: string[] }> {
    return { mismatched: [] };
  },
  async sessionRoutes(): Promise<{ routes: Array<{ sessionID: string; workspaceID: string; projectDirectory: string }> }> {
    return { routes: [] };
  },
  async compatibility(): Promise<WorkspaceCompatibilityResult> {
    return unsupportedCompatibility;
  },
  async readiness(): Promise<WorkspaceReadinessResult> {
    return { ...unsupportedCompatibility, enabled: false, defaultProvider: 'docker', providers: [] };
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
