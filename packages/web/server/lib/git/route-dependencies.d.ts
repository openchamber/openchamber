import type { registerSourceControlRoutes } from '../source-control/routes.js';
import type { createContributorProvenanceStore } from './contributor-provenance-storage.js';
import type { createManagedSshInventory } from './credentials.js';
import type { createHttpsCredentialReference } from './credential-resolver.js';
import type { createNetworkOperations } from './network-operations.js';
import type { createGitRedactor } from './redaction.js';
import type { subscribeWorktreeTopologyChanges } from './service.js';
import type { createWorktreeBootstrapStore } from './worktree-bootstrap-storage.js';

type BindingRoutes = ReturnType<typeof registerSourceControlRoutes>;

export interface GitRouteDependencies {
  networkOperations?: ReturnType<typeof createNetworkOperations>;
  managedSshInventory?: ReturnType<typeof createManagedSshInventory>;
  contributorProvenance?: ReturnType<typeof createContributorProvenanceStore>;
  getSourceControlBinding?: BindingRoutes['get'];
  resolveChangeRequestSource?: BindingRoutes['resolveChangeRequestSource'];
  backfillIdentities?: BindingRoutes['backfillConnectedIdentities'];
  createHttpsCredentialReference?: typeof createHttpsCredentialReference;
  resolveSourceControlAccount?: NonNullable<Parameters<typeof createNetworkOperations>[0]>['resolveSourceControlAccount'];
  errorRedactionSecrets?: NonNullable<Parameters<typeof createGitRedactor>[0]>['secrets'];
  worktreeBootstrapStore?: ReturnType<typeof createWorktreeBootstrapStore>;
  emitWorktreeChanged?: Parameters<typeof subscribeWorktreeTopologyChanges>[0];
  buildOpenCodeUrl?: (path: string, prefix?: string | null) => string;
  getOpenCodeAuthHeaders?: () => Record<string, string>;
  onBranchRewritten?: BindingRoutes['invalidateBranchStatus'];
}
