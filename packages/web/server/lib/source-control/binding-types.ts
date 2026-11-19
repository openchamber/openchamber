import type { ProviderId } from './provider-id.js';

export interface SourceControlRepositoryEndpoint {
  displayUrl: string;
  fingerprint: string;
}

export interface SourceControlRepositoryRemote {
  name: string;
  fetch: SourceControlRepositoryEndpoint;
  push: SourceControlRepositoryEndpoint;
}

export interface SourceControlRepositoryContext {
  repositoryId: string;
  configRevision: string;
  bare: boolean;
  remotes: SourceControlRepositoryRemote[];
}

export interface SourceControlProviderBinding {
  provider: ProviderId;
  instance: string;
  instanceSshUrl?: string;
  instanceAliases?: string[];
  accountId: string;
  primaryRemote: string;
  repository?: { owner: string; name: string };
}

export type SourceControlManagedCredentialPresentation =
  | {
      status: 'available';
      transport: 'https';
      provider: ProviderId;
      instance: string;
      source: 'oauth' | 'pat' | 'cli';
      username: string;
      providerUserId: string;
    }
  | { status: 'available'; transport: 'ssh'; fingerprint: string }
  | { status: 'unavailable' };

export interface SourceControlRepositoryBinding {
  repositoryId: string;
  revision: number;
  providers: Array<SourceControlProviderBinding & {
    readiness: 'ready' | 'confirmation-required' | 'account-unavailable' | 'config-changed';
    endpoint: SourceControlRepositoryEndpoint | null;
  }>;
  remotes: Array<SourceControlRepositoryRemote & {
    readiness: 'ready' | 'confirmation-required' | 'config-changed';
    inherited?: true;
  } & (
    | { mode: 'managed'; credentialId: string; presentation?: SourceControlManagedCredentialPresentation }
    | { mode: 'system'; credentialId?: never }
    | { mode: 'anonymous'; credentialId?: never }
  )>;
  auxiliary: Array<{
    kind: 'submodule' | 'lfs';
    endpoint: SourceControlRepositoryEndpoint;
    readiness: 'ready' | 'confirmation-required';
  } & (
    | { mode: 'managed'; credentialId: string }
    | { mode: 'system'; credentialId?: never }
    | { mode: 'anonymous'; credentialId?: never }
  )>;
  state: 'bound' | 'needs-attention';
  configRevision: string;
}
