import fsp from 'node:fs/promises';
import path from 'node:path';
import { fingerprintRemoteUrl } from '../source-control/url-redaction.js';
import { cleanBranchName } from './existing-branch-refs.js';
import type { createRemoteProvisioning } from './remote-provisioning.js';
import type {
  BootstrapStore, GitCommandResult, WorktreeBootstrapState, WorktreeBootstrapTask, WorktreeCreateInput,
  WorktreeCreateResult, WorktreeEntry, WorktreeProjectContext, WorktreeServerOptions,
} from './service-contracts.js';

interface WorktreeResumeDependencies extends Pick<ReturnType<typeof createRemoteProvisioning>,
  'networkRemoteName' | 'withRemoteProvisioningQueue' | 'ensureRemoteWithUrlUnlocked'> {
  runGitCommand(cwd: string, args: string[]): Promise<GitCommandResult>;
  runGitCommandOrThrow(cwd: string, args: string[], fallbackMessage?: string): Promise<GitCommandResult>;
  findBranchInUse(primaryWorktree: string, localBranch: string): Promise<WorktreeEntry | null>;
  readFailedWorktreeSetup(primaryWorktree: string, directory: string, bootstrapStore?: BootstrapStore): Promise<WorktreeBootstrapState | null>;
  startWorktreeBootstrap(task: WorktreeBootstrapTask): Promise<WorktreeBootstrapState>;
  normalizeGitOutputPath(value: string): string;
  checkPathExists(value: string): Promise<boolean>;
}

export const contributorProvenanceResult = (revision: number): NonNullable<WorktreeCreateResult['provenance']> => ({
  kind: 'contributor-fork', revision, trust: 'untrusted', push: 'destination-selection-required',
});

export const createWorktreeResume = ({
  networkRemoteName, withRemoteProvisioningQueue, ensureRemoteWithUrlUnlocked, runGitCommand, runGitCommandOrThrow,
  findBranchInUse, readFailedWorktreeSetup, startWorktreeBootstrap, normalizeGitOutputPath, checkPathExists,
}: WorktreeResumeDependencies) => {
  const readMatchingProvenanceRevision = async (directory: string, input: WorktreeCreateInput, { contributorProvenance, contributorSource }: WorktreeServerOptions) => {
    if (!contributorProvenance?.read) return null;
    const { revision, provenance } = await contributorProvenance.read(directory);
    if (input.contributorFork !== true) return provenance === null ? 0 : null;
    return provenance !== null && contributorSource
      && provenance.endpointFingerprint === fingerprintRemoteUrl(input.ensureRemoteUrl ?? '')
      && provenance.sourceSha === input.expectedRevision?.toLowerCase()
      && provenance.sourceRef === contributorSource.headRef
      && provenance.sourceProjectId === contributorSource.sourceProject.id
      && provenance.targetProjectId === contributorSource.targetProject.id
      ? revision : null;
  };

  const isWorktreePopulated = async (directory: string) => {
    const index = await runGitCommandOrThrow(directory, ['rev-parse', '--git-path', 'index'], 'Failed to read the worktree index');
    return checkPathExists(path.resolve(directory, normalizeGitOutputPath(index.stdout.trim())));
  };

  const failedBeforeSetupCommands = async (directory: string, failed: WorktreeBootstrapState) => {
    if (failed.phase !== 'directory-created' || failed.errorCode === 'OUTCOME_UNKNOWN') return false;
    const gitDirectory = await runGitCommandOrThrow(directory, ['rev-parse', '--absolute-git-dir'], 'Failed to read the worktree Git directory');
    const { birthtimeMs } = await fsp.stat(normalizeGitOutputPath(gitDirectory.stdout.trim()));
    return birthtimeMs <= failed.updatedAt;
  };

  const resumeFailedChangeRequestWorktree = async (context: WorktreeProjectContext, input: WorktreeCreateInput, serverOptions: WorktreeServerOptions): Promise<WorktreeCreateResult | null> => {
    const { primaryWorktree } = context;
    const expectedRevision = String(input.expectedRevision || '').trim();
    const ensureRemoteName = String(input.ensureRemoteName || '').trim();
    const ensureRemoteUrl = String(input.ensureRemoteUrl || '').trim();
    if (input.mode !== 'existing' || input.changeRequestTransfer !== true || !expectedRevision || !ensureRemoteName || !ensureRemoteUrl) return null;
    const localBranch = cleanBranchName(String(input.branchName || '').trim());
    return withRemoteProvisioningQueue(primaryWorktree, ensureRemoteName, async () => {
      const entry = await findBranchInUse(primaryWorktree, localBranch);
      if (!entry?.worktree) return null;
      const directory = entry.worktree;
      const failed = await readFailedWorktreeSetup(primaryWorktree, directory, serverOptions.bootstrapStore);
      if (!failed) return null;
      const head = await runGitCommand(directory, ['rev-parse', '--verify', 'HEAD']);
      if (!head.success || head.stdout.trim() !== expectedRevision) return null;
      if (!(await isWorktreePopulated(directory))) return null;
      if (input.contributorFork !== true && !(await failedBeforeSetupCommands(directory, failed))) return null;
      const provenanceRevision = await readMatchingProvenanceRevision(directory, input, serverOptions);
      if (provenanceRevision === null) return null;
      await ensureRemoteWithUrlUnlocked(primaryWorktree, ensureRemoteName, ensureRemoteUrl);
      const bootstrapStatus = await startWorktreeBootstrap({
        directory,
        projectDirectory: context.requestedDirectory,
        primaryWorktree,
        localBranch,
        setUpstream: false,
        upstreamRemote: '',
        upstreamBranch: '',
        ensureRemoteName,
        ensureRemoteUrl,
        startCommand: input.startCommand,
        contributorFork: input.contributorFork === true,
        hydrateCheckout: serverOptions.hydrateCheckout,
        checkoutRemoteName: await networkRemoteName(primaryWorktree, ensureRemoteName),
        bootstrapStore: serverOptions.bootstrapStore,
        populated: true,
        resumed: true,
        disposeInstance: serverOptions.disposeInstance,
      });
      const result: WorktreeCreateResult = {
        head: expectedRevision,
        name: path.basename(directory),
        branch: localBranch,
        path: directory,
        directoryCreated: true,
        bootstrapStatus,
      };
      if (input.contributorFork === true) result.provenance = contributorProvenanceResult(provenanceRevision);
      return result;
    });
  };

  return { resumeFailedChangeRequestWorktree };
};
