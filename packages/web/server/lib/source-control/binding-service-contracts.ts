import type { SourceControlMutationTarget } from '@openchamber/sdk';
import type { BindingDraft } from './binding-contract.js';
import type { createBindingStore } from './binding-storage.js';
import type { SourceControlProviderBinding, SourceControlRepositoryContext, SourceControlRepositoryEndpoint } from './binding-types.js';
import type { AccountIdentity, TransportCredential } from './provider-contract.js';
import type { AuthUser } from './auth-storage.js';
import type { sshHostReaches } from '../git/ssh-host-alias.js';

export interface RepositoryIdentity extends SourceControlRepositoryContext {
  supported: true;
  transportRevision?: string;
  remotes: Array<{
    name: string;
    fetch: SourceControlRepositoryEndpoint & { rawUrl?: string };
    push: SourceControlRepositoryEndpoint & { rawUrl?: string };
  }>;
}

export type RepositoryResolution = RepositoryIdentity | { supported: false; reason: string };
export type RepositoryResolver = (directory: string) => Promise<RepositoryResolution>;
export type BindingStore = ReturnType<typeof createBindingStore>;
export type PresentedBinding = BindingDraft & {
  repositoryId: string;
  revision: number;
};

export interface BindingRead {
  repository: SourceControlRepositoryContext;
  revision: number;
  binding: PresentedBinding | null;
}

export interface BindingServiceOptions {
  store: BindingStore;
  resolveRepository: RepositoryResolver;
  resolveTransportRepository?: RepositoryResolver | undefined;
  readTransportAccount?: (identity: AccountIdentity & { credentialRevision?: number }) => Promise<BindingTransportAccount | null>;
  validateManagedSshCredential?: (credentialId: string) => Promise<void>;
  readManagedSshCredentialPresentation?: (credentialId: string, deadline: number) => Promise<{ fingerprint: string } | null>;
  resolveCheckoutAuxiliary?: (input: {
    directory: string; parentEndpoint: string; parentRemoteName: string; kind: 'submodule' | 'lfs'; path: string;
  }) => Promise<{ kind: 'submodule' | 'lfs'; path: string; endpoint: SourceControlRepositoryEndpoint } | null>;
  sshHostReaches?: typeof sshHostReaches;
  readProviderSshUrl?: (identity: { provider: string; instance: string }) => Promise<string | null>;
}

export type BindingTransportAccount = Omit<TransportCredential, 'user'> & {
  user: Omit<TransportCredential['user'], 'id'> & Pick<AuthUser, 'id'>;
};

export type ProviderBindingInput = SourceControlProviderBinding;
export interface RemoteBindingInput {
  name: string;
  mode: 'system' | 'managed' | 'anonymous';
  credentialId?: string;
  unverifiedConfirmed?: boolean;
}
export interface AuxiliaryBindingInput {
  kind: 'submodule' | 'lfs';
  endpoint: SourceControlRepositoryEndpoint;
  mode: 'system' | 'managed' | 'anonymous';
  credentialId?: string;
  unverifiedConfirmed?: boolean | undefined;
}

export interface BindingIntent {
  directory: string;
  expectedRepositoryId: string;
  expectedRevision: number;
  expectedConfigRevision: string;
  expectedFetchFingerprint: string;
  expectedPushFingerprint: string;
  remote: string;
  operation: 'configure' | 'remove' | 'add' | 'replace';
  transport: 'system' | 'https' | 'ssh' | 'anonymous';
  unverifiedConfirmed?: boolean;
  credentialAccount?: AccountIdentity;
  sshCredentialId?: string;
  kind: 'submodule' | 'lfs';
  path: string;
  parentRemote: string;
  expectedParentFingerprint: string;
  expectedEndpointFingerprint: string;
  target: AccountIdentity & { primaryRemote: string };
  provider: ProviderBindingInput;
  binding: {
    providers: ProviderBindingInput[];
    remotes: RemoteBindingInput[];
    auxiliary?: AuxiliaryBindingInput[];
    state: 'bound' | 'needs-attention';
  };
  confirmed?: boolean;
}

export interface TransportContextInput {
  directory: string;
  repositoryId: string;
  bindingRevision: number;
  configRevision: string;
  remote: string;
  endpointKind: 'fetch' | 'push';
}

export interface AuxiliaryContextInput {
  directory: string;
  repositoryId: string;
  bindingRevision: number;
  configRevision: string;
  kind: 'submodule' | 'lfs';
  rawEndpoint: string;
  parentRemote?: string;
}

export interface TransportAuthority extends Omit<TransportContextInput, 'endpointKind'> {
  endpointKind: 'fetch' | 'push';
  transportRevision: string;
  endpoint: string;
  endpointFingerprint: string;
  transportMode: 'system' | 'managed' | 'anonymous';
  credentialId?: string;
  primaryOf?: string[];
}

export interface AuxiliaryAuthority extends Omit<AuxiliaryContextInput, 'rawEndpoint' | 'parentRemote'> {
  transportRevision: string;
  endpoint: string;
  endpointFingerprint: string;
  transportMode: 'system' | 'managed' | 'anonymous';
  credentialId?: string;
}

export interface CloneBindingInput {
  directory: string;
  approvedEndpoint: string;
  transportMode: 'system' | 'managed' | 'anonymous';
  credentialId?: string | undefined;
  unverifiedConfirmed?: boolean | undefined;
  providerAccount?: AccountIdentity | undefined;
  auxiliaryGrants?: Array<{
    kind: 'submodule' | 'lfs';
    endpoint: SourceControlRepositoryEndpoint;
    transportMode: 'system' | 'managed' | 'anonymous';
    credentialId?: string;
    unverifiedConfirmed?: boolean;
  }>;
}

export type BindingMutationTarget = Pick<SourceControlMutationTarget, 'number' | 'head' | 'base' | 'headSha'> & { project: { owner: string; name: string } };

export type MutationContextInput = AccountIdentity & {
  directory: string;
  repositoryId: string;
  bindingRevision: number;
  primaryRemote: string;
  idempotencyKey: string;
  target: BindingMutationTarget;
};
