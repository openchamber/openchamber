import type { GitAPI } from '@/lib/api/types';
import { BoundGitNetworkOperationError } from '@/lib/boundGitNetworkOperation';

export type BranchIntegrationTarget =
  | { kind: 'local'; branch: string; label: string }
  | {
      kind: 'remote';
      branch: string;
      destinationRef: string;
      label: string;
      remote: string;
      sourceRef: string;
    };

export type BranchIntegrationRemoteBranch = Extract<BranchIntegrationTarget, { kind: 'remote' }>;

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export const createRemoteBranchIntegrationTargets = (
  remoteNames: string[],
  branchLabels: string[],
): BranchIntegrationRemoteBranch[] => {
  const namesBySpecificity = [...remoteNames].sort((left, right) => right.length - left.length);
  return branchLabels.flatMap<BranchIntegrationRemoteBranch>((label) => {
    const remote = namesBySpecificity.find((name) => label.startsWith(`${name}/`));
    if (!remote) return [];
    const branch = label.slice(remote.length + 1);
    if (!branch) return [];
    return [{
      kind: 'remote',
      branch,
      destinationRef: `refs/remotes/${remote}/${branch}`,
      label,
      remote,
      sourceRef: `refs/heads/${branch}`,
    }];
  });
};

export const resolveBranchIntegrationRef = async ({
  directory,
  git,
  runPlannedFetch,
  target,
}: {
  directory: string;
  git: Pick<GitAPI, 'getGitLog'>;
  runPlannedFetch: (target: Extract<BranchIntegrationTarget, { kind: 'remote' }>) => Promise<void>;
  target: BranchIntegrationTarget;
}): Promise<string> => {
  if (target.kind === 'local') return target.branch;

  await runPlannedFetch(target);
  const fetched = await git.getGitLog(directory, { to: target.destinationRef, maxCount: 1 });
  const sha = fetched.latest?.hash.trim();
  if (!sha || !SHA_PATTERN.test(sha)) {
    throw new BoundGitNetworkOperationError('invalid-terminal-state');
  }
  return sha;
};
