import type fs from 'node:fs/promises';
import type path from 'node:path';
import type { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import type { JsonValue } from '../shared/json-values.js';
import type { createManagedSshInventory } from './credentials.js';

export type TransportMode = 'managed' | 'system' | 'anonymous';
export type NetworkRuntimeIdentity = {
  id: string;
  platform: string;
  label?: string;
}
export type EndpointDisplay = {
  displayUrl: string;
  fingerprint: string;
}
export type NetworkRemote = {
  name: string;
  endpoint: EndpointDisplay;
}
export type TransportContext = {
  directory: string;
  repositoryId: string;
  bindingRevision: number;
  configRevision: string;
  remote: string;
  endpointKind: 'fetch' | 'push';
}
export type TransportAuthority = {
  endpoint: string;
  endpointFingerprint: string;
  transportMode: TransportMode;
  transportRevision: string;
  credentialId?: string;
  primaryOf?: string[];
}
export type ContributorAuthority = {
  worktreeId: string;
  revision: number;
  provenance?: { kind: string } | null;
}
export type HydrationRequirement = {
  kind: 'submodule' | 'lfs';
  path: string;
  endpoint: EndpointDisplay;
}
export type HydrationTransfer = HydrationRequirement & {
  rawEndpoint: string;
}
export type HydrationInspection = {
  headSha: string;
  requirements: HydrationRequirement[];
  transfers: HydrationTransfer[];
  sourceRequired?: boolean;
}
export type AuxiliaryGrant = {
  kind: 'submodule' | 'lfs';
  endpoint: EndpointDisplay;
  transportMode: TransportMode;
  credentialId?: string;
  unverifiedConfirmed?: boolean;
}
export type ProviderAccount = {
  provider: string;
  instance: string;
  accountId: string;
}
export type PlannerOptions = {
  validateGitTransportContext?: (input: TransportContext) => Promise<TransportAuthority>;
  validateManagedSshCredential?: ReturnType<typeof createManagedSshInventory>['assertAvailable'] | undefined;
  resolveSourceControlAccount?: ((input: ProviderAccount) => Promise<{
    credentialId?: string;
    status?: string;
    credentialRevision?: number;
    providerUserId?: string;
    secret?: string | undefined;
  } | null>) | undefined;
  sourceControlProviders?: typeof sourceControlProviderDescriptors | undefined;
  contributorProvenance?: { read(directory: string): Promise<ContributorAuthority> } | undefined;
  resolveRef?: (directory: string, ref: string) => Promise<string>;
  resolveSymbolicRef?: (directory: string) => Promise<string | null>;
  resolveRemoteFetchMapping?: (directory: string, remote: string) => Promise<string>;
  checkBranchName?: (directory: string, name: string) => Promise<string | null>;
  inspectCheckoutHydration?: (input: {
    directory: string;
    parentEndpoint: string;
    parentRemoteName: string;
  }) => Promise<HydrationInspection>;
  runtimeIdentity?: NetworkRuntimeIdentity | undefined;
  idFactory?: (() => string) | undefined;
  fsImpl?: typeof fs;
  pathImpl?: typeof path;
}
export type ReviewPush = {
  target: string;
  topic?: string;
  wip?: boolean;
  private?: boolean;
  hashtags?: string[];
}
export type ForceWithLease = {
  expectedRemoteSha: string;
}
export type ExistingTarget = {
  operation: string;
  repositoryId: string;
  bindingRevision: number;
  configRevision: string;
  remote: NetworkRemote;
  sourceRef?: string;
  destinationRef?: string;
  fetchScope?: 'remote' | 'ref';
  force?: boolean;
  forceWithLease?: ForceWithLease;
  configureUpstream?: boolean;
}
export type ExistingInternal = {
  directory: string;
  endpointKind: 'push' | 'fetch';
  transportMode: TransportMode;
  transportRevision: string;
  credentialId?: string;
  fetchRefspec?: string;
  sourceSha?: string;
  pushRefspec?: string;
  changeReviewRemote?: boolean;
  contributorAuthority?: { worktreeId: string; revision: number };
  destinationSha?: string;
}
export type CloneInternal = {
  destination: string;
  temporaryDirectory: string;
  transportMode: TransportMode;
  auxiliaryGrants: AuxiliaryGrant[];
  providerAccount?: ProviderAccount;
  unverifiedConfirmed?: boolean;
  credentialId?: string;
  gitIdentityId?: string;
}
export type ContributorSelection = {
  worktreeId: string;
  provenanceRevision: number;
  repositoryId: JsonValue | undefined;
  bindingRevision: number;
  configRevision: JsonValue | undefined;
  sourceSha: string;
  remoteName: string;
  endpointFingerprint: string;
  destinationRef: string;
  expiresAt: number;
}
export type UncheckedNetworkInput = {
  operation?: JsonValue | undefined;
  directory?: JsonValue | undefined;
  repositoryId?: JsonValue | undefined;
  bindingRevision?: JsonValue | undefined;
  configRevision?: JsonValue | undefined;
  fetch?: JsonValue | undefined;
  pull?: JsonValue | undefined;
  push?: JsonValue | undefined;
  remote?: JsonValue | undefined;
  transportMode?: JsonValue | undefined;
  fetchScope?: JsonValue | undefined;
  review?: JsonValue | undefined;
  destinationRef?: JsonValue | undefined;
  sourceRef?: JsonValue | undefined;
  configureUpstream?: JsonValue | undefined;
  forceWithLease?: JsonValue | undefined;
  destinationSelectionId?: JsonValue | undefined;
  remoteUrl?: JsonValue | undefined;
  destinationPath?: JsonValue | undefined;
  credentialAccount?: JsonValue | undefined;
  providerAccount?: JsonValue | undefined;
  sshCredentialId?: JsonValue | undefined;
  unverifiedConfirmed?: JsonValue | undefined;
  gitIdentityId?: JsonValue | undefined;
  auxiliaryGrants?: JsonValue | undefined;
  provenanceRevision?: JsonValue | undefined;
}
export type SyncInputTarget = {
  remote?: JsonValue | undefined;
  sourceRef?: JsonValue | undefined;
  destinationRef?: JsonValue | undefined;
  forceWithLease?: ForceWithLease | undefined;
}
export type SyncInternalTarget = {
  operation: string;
  repositoryId: string;
  bindingRevision: number;
  configRevision: string;
  remote: JsonValue | undefined;
  sourceRef: JsonValue | undefined;
  destinationRef: JsonValue | undefined;
  forceWithLease?: ForceWithLease;
}
export type FrozenPlanJson = null | boolean | number | string | readonly FrozenPlanJson[] | { readonly [key: string]: FrozenPlanJson | undefined };
