import type { ResolvedChangeRequestSource } from '../source-control/provider-contract.js';
import type { spawn, ChildProcess } from 'node:child_process';
import type fs from 'node:fs/promises';
import type path from 'node:path';
import type { Stats } from 'node:fs';
import type { createNetworkOperationPlanner } from './network-operation-plan.js';
import type { createGitCredentialResolver } from './credential-resolver.js';
import type { createGitCredentialBroker } from './credential-broker.js';
import type { createNetworkOperationRegistry } from './network-operation-registry.js';
import type { createGitNetworkOperationStore } from './network-operation-storage.js';
import type { createSourceControlAuditStore } from '../source-control/audit-storage.js';
import type { createBindingService } from '../source-control/binding-service.js';
import type { ProviderReadContext } from '../source-control/provider-contract.js';
import type { inspectContributorCheckoutActions } from './service.js';
import type { PostCheckoutHookAction } from './service-contracts.js';
import type {
  AuxiliaryGrant, EndpointDisplay, HydrationRequirement,
  HydrationTransfer, NetworkRuntimeIdentity, PlannerOptions, TransportMode,
} from './network-plan-contracts.js';
import type { CheckoutHydration, HydrationPart } from './service-contracts.js';
import type { StoredNetworkSnapshot } from './network-storage-contracts.js';
import type { RegistrySnapshot } from './network-operation-registry.js';

export type PlannedNetworkOperation = Awaited<ReturnType<ReturnType<typeof createNetworkOperationPlanner>['planNetworkOperation']>>;
export type PlannerInternal = PlannedNetworkOperation['internalPlan'];
export type ExistingPlan = import('./network-plan-contracts.js').ExistingInternal & {
  operationId: string;
  rawEndpoint?: string;
  transportRole?: string;
  target: import('./network-plan-contracts.js').ExistingTarget;
};
export type ClonePlan = Extract<PlannerInternal, { destination: string }>;
export type SyncPlan = Extract<PlannerInternal, { fetch: object }>;
export type PhaseControls = {
  isCancellationRequested(): boolean;
  onCancellationRequested(listener: () => void): () => void;
};
export type ExecutionControls = PhaseControls & {
  attachChild(child: ChildProcess, options?: { allowAfterCancellation?: boolean }): void;
  detachChild(child: ChildProcess): void;
  markTransferStarted(role?: string | undefined): PromiseLike<StoredNetworkSnapshot | RegistrySnapshot | void> | void;
  hasTransferStarted(role?: string): boolean;
  markIntegrationStarted(): PromiseLike<StoredNetworkSnapshot | RegistrySnapshot | void> | void;
  markStepCompleted(step: string): PromiseLike<RegistrySnapshot> | RegistrySnapshot;
  updateTransportMetadata(metadata: { fingerprint: string } | { provider: string; instance: string; accountId: string; login: string | null }, role?: string | undefined): void;
};
export type PublicFailure = { code: unknown; message: unknown };
export type Completion = {
  state: string;
  error?: PublicFailure;
  hydration?: CheckoutHydration;
  stepResults?: { step: string; status: string; error?: PublicFailure }[];
};
export type HydrationFailure = { status: string; error: { code: string; message: string } };
type HydrationFailurePart = HydrationFailure & { path: string };
export type CheckoutHydrationFailure = Readonly<{
  status: string;
  submodules: HydrationFailurePart[];
  lfs: HydrationFailurePart[];
}>;
export type RepositoryAuthority = {
  directory?: string;
  repositoryId: string;
  bindingRevision: number;
  configRevision: string;
};
export type HydrationInput = {
  directory: string;
  parentEndpoint?: string | undefined;
  parentRemoteName?: string | undefined;
  repositoryAuthority?: RepositoryAuthority | null | undefined;
};
export type HydrationPlan = HydrationInput & {
  operationId: string;
  target: { operation: string; repositoryId?: string };
  authorityDirectory?: string;
  auxiliaryGrants?: AuxiliaryGrant[];
  plannedAuxiliaryAuthorities?: AuxiliaryAuthority[];
  plannedTransfers?: HydrationTransfer[];
  plannedRequirements?: HydrationRequirement[];
  plannedSourceRequired?: boolean | undefined;
  expectedHeadSha?: string;
  preparedHydrationFailure?: CheckoutHydrationFailure;
  hydrateSubmodules?: boolean;
};
export type AuxiliaryAuthority = {
  kind?: 'submodule' | 'lfs';
  endpoint?: string;
  rawEndpoint?: string;
  endpointFingerprint: string;
  transportMode: TransportMode;
  transportRevision?: string;
  credentialId?: string | undefined;
};
export type SourceRequest = {
  context: ProviderReadContext;
  project: { id: string; owner: string; name: string };
  number: number;
  expectedHeadSha: string;
  requestedRemoteName: string;
};
export type ContributorTransferSource = {
  context: SourceRequest['context'];
  endpoint: string;
  headRef: string;
  headSha: string;
  requestedRemoteName: string;
  sourceProject: { id: string };
};
export type ContributorPlan = {
  operationId: string;
  directory: string;
  rawEndpoint: string;
  transportMode: 'managed';
  credentialId: string;
  expectedSha: string;
  sourceRequest: SourceRequest;
  sourceAuthority: {
    repositoryId: string;
    bindingRevision: number;
    accountId: string;
    instance: string;
    primaryRemote: string;
    sourceProjectId: string;
  };
  target: {
    operation: string;
    remote: { name: string; endpoint: EndpointDisplay };
    sourceRef: string;
    destinationRef: string;
  };
};
export type CheckoutInspection = Awaited<ReturnType<typeof inspectContributorCheckoutActions>>;
export type CheckoutTrustInput = {
  directory: string;
  repositoryId: string;
  digest: string;
  decision: string;
  inspect: () => Promise<CheckoutInspection>;
  headSha: string;
  nullRef: string;
};
export type CheckoutActionsPlan = Omit<CheckoutTrustInput, 'digest' | 'decision' | 'repositoryId'> & {
  operationId: string;
  actionDigest: string;
  auditRepositoryId: string;
  target: { operation: string };
};
export type ExecutionPlan = PlannerInternal | HydrationPlan | ContributorPlan | CheckoutActionsPlan;
export type TransportPlan = {
  operationId: string;
  directory?: string | undefined;
  destination?: string;
  temporaryDirectory?: string;
  rawEndpoint?: string;
  transportMode: TransportMode;
  credentialId?: string | undefined;
  auxiliaryKind?: 'submodule' | 'lfs';
  lfsDerivedFromRemote?: string | undefined;
  transportRole?: string;
  target: { operation: string };
};
export type PublicTarget = {
  operation: string;
  repositoryId?: string;
  remote?: { name?: string; endpoint?: EndpointDisplay; fingerprint?: string; sourceRef?: string; destinationRef?: string };
  fetch?: { name: string; endpoint: EndpointDisplay; sourceRef: string; destinationRef: string };
  push?: { name: string; endpoint: EndpointDisplay; sourceRef: string; destinationRef: string };
  destination?: { displayName: string; fingerprint: string };
  fetchScope?: 'remote' | 'ref';
  force?: boolean;
};
export type AuditPlans = {
  publicPlan: { operationId: string; runtimeIdentity: NetworkRuntimeIdentity | undefined; target: PublicTarget };
  internalPlan: ExecutionPlan;
};
export type TransportContext = {
  env: NodeJS.ProcessEnv;
  configArgs: readonly string[];
  secrets: (string | undefined)[];
};
export type LeasedTransportContext = TransportContext & { revoke(): Promise<boolean | void> };
export type RunOptions = {
  binary?: string;
  cwd: string | undefined;
  args: string[];
  env: NodeJS.ProcessEnv;
  controls?: ExecutionControls | undefined;
  deadline: number;
  input?: Buffer | undefined;
  allowAfterCancellation?: boolean;
  transfer?: boolean;
  transferRole?: string | undefined;
  maxOutputBytes?: number;
  rawOutput?: boolean;
  requireCompleteOutput?: boolean;
  onStdout?: ((chunk: Buffer) => void | Promise<void>) | undefined;
};
export type RunResult<Output = string> = {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: Output;
  stderr: string;
};
export type LocalGitOptions = Pick<RunOptions, 'input' | 'maxOutputBytes' | 'rawOutput' | 'onStdout'> & {
  allowedCodes?: (number | null)[];
  disableLfsFilters?: boolean;
};
export type NetworkOperationsOptions = Omit<PlannerOptions, 'resolveRef' | 'resolveSymbolicRef' | 'resolveRemoteFetchMapping'> & {
  resolveRef?: (directory: string, ref: string, options?: PhaseOptions) => Promise<string>;
  resolveSymbolicRef?: (directory: string, options?: PhaseOptions) => Promise<string | null>;
  resolveRemoteFetchMapping?: (directory: string, remote: string, options?: PhaseOptions) => Promise<string>;
  credentialResolver?: ReturnType<typeof createGitCredentialResolver>;
  credentialBroker?: ReturnType<typeof createGitCredentialBroker>;
  registry?: ReturnType<typeof createNetworkOperationRegistry>;
  spawnImpl?: typeof spawn;
  gitBinary?: string;
  inheritedEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  outputLimitBytes?: number;
  escalationMs?: number;
  validateGitIdentity?: (id: string) => Promise<{ userName: string; userEmail: string }>;
  resolveGitIdentity?: (id: string) => Promise<{ userName: string; userEmail: string } | null>;
  applyGitIdentity?: (directory: string, id: string) => Promise<void>;
  bindClonedRepository?: ReturnType<typeof createBindingService>['bindClonedRepository'];
  inspectMergeState?: (directory: string) => Promise<boolean>;
  enumerateManagedConfigKeys?: (plan: TransportPlan, controls: ExecutionControls, deadline: number, env: NodeJS.ProcessEnv) => Promise<string[]>;
  resolveChangeRequestSource?: (input: SourceRequest) => Promise<ResolvedChangeRequestSource>;
  validateGitAuxiliaryContext?: ReturnType<typeof createBindingService>['validateGitAuxiliaryContext'];
  auditStore?: ReturnType<typeof createSourceControlAuditStore>;
  operationStore?: ReturnType<typeof createGitNetworkOperationStore> | undefined;
  onCheckoutHydrated?: (directory: string) => Promise<import('./service-contracts.js').WorktreeBootstrapState | null>;
  trustedDirectoriesConfig?: () => Promise<string | null>;
};
export type PhaseOptions = { controls?: ExecutionControls | undefined; deadline?: number };
export type TrustedDirectoriesOptions = {
  gitBinary?: string;
  inheritedEnv?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
  fsImpl?: typeof fs;
  pathImpl?: typeof path;
  tmpdir?: () => string;
};
export type LstatSnapshot = Pick<Stats, 'mode' | 'size' | 'mtimeMs' | 'ctimeMs'> & { identity: string };
export type CopiedCheckoutEntry =
  | { path: string; kind: 'directory'; identity: string }
  | { path: string; kind: 'symlink'; snapshot: LstatSnapshot; link: string }
  | { path: string; kind: 'file'; snapshot: LstatSnapshot; contentDigest: string };
export type HydrationInspectionInput = HydrationInput & PhaseOptions;
export type HydrationRequirementWithEndpoint = HydrationRequirement & { rawEndpoint: string; transferReady: boolean; derivedFromRemote?: string };
export type { CheckoutHydration, HydrationPart, PostCheckoutHookAction };
