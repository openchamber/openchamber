import type fs from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import type { ProviderDescriptor } from '../source-control/provider-contract.js';
import type { BindingTransportAccount } from '../source-control/binding-service-contracts.js';
import type { createSshPassphraseStore } from './ssh-passphrases.js';
import type { ManagedSshCredentialRecord } from './ssh-credential-storage.js';

export interface CredentialProcessControls {
  attachChild(child: ChildProcess): void;
  detachChild(child: ChildProcess): void;
}

export interface CredentialFileOptions {
  input?: string;
  deadline?: number | undefined;
  controls?: CredentialProcessControls | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface CredentialFileResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CredentialFileExecutor = (file: string, args: string[], options?: CredentialFileOptions) => Promise<CredentialFileResult>;
export type SshPassphrases = ReturnType<typeof createSshPassphraseStore>;

export interface SshSnapshotOptions {
  privateKeyPath: string;
  realpath?: typeof fs.realpath;
  execute?: CredentialFileExecutor | undefined;
  fsImpl?: typeof fs;
  snapshotRoot: string | undefined;
  operationId: string;
  deadline?: number | undefined;
  controls?: CredentialProcessControls | undefined;
  approvedRoot?: string;
  expectedSourceIdentity?: string;
  requirePrivateMode?: boolean;
  rejectSymlinkPath?: boolean;
  passphrase?: string;
}

export interface SshInspectionOptions {
  snapshotRoot?: string;
  fsImpl?: typeof fs;
  executeFile?: CredentialFileExecutor | undefined;
  deadline?: number;
  passphrases?: SshPassphrases | undefined;
}

export interface CredentialResolverOptions {
  readTransportCredential?: (input: {
    provider: string;
    instance: string;
    credentialId: string;
    credentialRevision: number;
  }) => Promise<BindingTransportAccount | null>;
  describeProvider?: (provider: string) => ProviderDescriptor | null | undefined;
  lookupManagedSshKey?: (keyId: string) => Promise<ManagedSshCredentialRecord | null>;
  passphrases?: SshPassphrases;
  realpath?: typeof fs.realpath;
  executeFile?: CredentialFileExecutor;
  fsImpl?: typeof fs;
  snapshotRoot?: string;
}

export interface CredentialResolveInput {
  mode: string;
  credentialId?: string | undefined;
  endpoint?: { protocol: string; host: string; port: number; path: string } | undefined;
  operationId: string;
  deadline?: number;
  controls?: CredentialProcessControls;
}
