import type { ChangeRequest, GitBranchDetails, SourceControlReadContext } from '@/lib/api/types';

const normalizeBranchName = (value: string): string => value
  .trim()
  .replace(/^refs\/heads\//, '')
  .replace(/^heads\//, '')
  .replace(/\s+/g, '-')
  .replace(/^\/+|\/+$/g, '');

const sanitizeRemoteName = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'pr-head';
};

export const resolvePrWorktreeConfig = (
  changeRequest: ChangeRequest,
  context: SourceControlReadContext,
  branches: Record<string, GitBranchDetails>,
) => {
  const headBranch = normalizeBranchName(changeRequest.head);
  if (!headBranch) throw new Error('PR head branch is missing');
  const headSha = changeRequest.headSha?.trim();
  if (!headSha) throw new Error('PR head revision is missing');
  const ownerFromLabel = changeRequest.headLabel?.split(':')[0]?.trim();
  const remoteSeed = changeRequest.headProject?.owner || ownerFromLabel || 'pr-head';
  const remoteName = `pr-${sanitizeRemoteName(remoteSeed)}`;

  return {
    existingBranch: branches[headBranch]?.commit === headSha ? headBranch : `remotes/${remoteName}/${headBranch}`,
    expectedRevision: headSha,
    changeRequestSource: {
      context,
      project: {
        id: changeRequest.project.id,
        owner: changeRequest.project.owner,
        name: changeRequest.project.name,
      },
      number: changeRequest.number,
      expectedHeadSha: headSha,
      requestedRemoteName: remoteName,
    },
    sourceLabel: headBranch,
  };
};
