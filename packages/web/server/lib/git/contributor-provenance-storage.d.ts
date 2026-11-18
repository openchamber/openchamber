import type { ProviderId } from '../source-control/provider-id.js';

export interface ContributorProvenance {
  kind: 'contributor-fork';
  remoteName: string;
  endpointFingerprint: string;
  sourceSha: string;
  sourceRef: string;
  sourceProjectId: string;
  targetProjectId: string;
  provider: ProviderId;
  instance: string;
  accountId: string;
  bindingRevision: number;
  primaryRemote: string;
  projectId: string;
  setupCommand: string;
}

export interface ContributorProvenanceRead {
  worktreeId: string;
  repositoryId: string;
  gitDirectory?: string;
  revision: number;
  provenance: ContributorProvenance | null;
}

export function isContributorForkGitDirectory(input: {
  filePath: string;
  gitDirectory: string;
}): Promise<boolean>;
