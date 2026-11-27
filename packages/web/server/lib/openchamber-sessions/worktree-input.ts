import { OpenChamberControlError } from '../openchamber-control/error.js';
import { asNonEmptyString } from '../shared/guards.js';

interface PullRequestInput {
  number: number;
  name?: string;
  branchName?: string;
}

interface WorktreeInput {
  mode: 'new' | 'existing';
  name: string;
  branchName?: string;
  startRef?: string;
  existingBranch?: string;
  setUpstream?: boolean;
}

interface WorktreeFields {
  name?: unknown;
  branchName?: unknown;
  startRef?: unknown;
  existingBranch?: unknown;
}

interface WorktreeRequestPayload {
  pullRequest?: unknown;
  worktree?: unknown;
  setUpstream?: unknown;
}

const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const hasWorktreeFields = (value: unknown): value is WorktreeFields => value !== null && value !== undefined;
const isWorktreeFields = (value: unknown): value is WorktreeFields => !!value && typeof value === 'object';

export const worktreeFields = (
  payload: Pick<WorktreeRequestPayload, 'worktree'> | null | undefined,
): WorktreeFields | undefined => (hasWorktreeFields(payload?.worktree) ? payload.worktree : undefined);

export const resolvePullRequestInput = (payload: WorktreeRequestPayload): PullRequestInput | null => {
  if (payload?.pullRequest === undefined) return null;
  if (!isSafeInteger(payload.pullRequest) || payload.pullRequest < 1) {
    throw new OpenChamberControlError('pullRequest must be a pull or merge request number, such as 42', 400);
  }
  const fields = worktreeFields(payload);
  if (fields?.startRef !== undefined || payload.setUpstream !== undefined) {
    throw new OpenChamberControlError('pullRequest checks out the pull request\'s own branch; do not combine it with startRef or setUpstream', 400);
  }
  if (fields?.existingBranch !== undefined) {
    throw new OpenChamberControlError('pullRequest checks out the pull request\'s own branch; do not combine it with existingBranch', 400);
  }
  const input: PullRequestInput = { number: payload.pullRequest };
  const name = asNonEmptyString(fields?.name);
  if (name) input.name = name;
  const branchName = asNonEmptyString(fields?.branchName);
  if (branchName) input.branchName = branchName;
  return input;
};

export const assertExistingBranchAvailable = async (
  isAvailableLocally: (directory: string, existingBranch: string) => Promise<boolean>,
  directory: string,
  existingBranch: string,
) => {
  if (await isAvailableLocally(directory, existingBranch)) return;
  throw new OpenChamberControlError(
    `Branch ${existingBranch} is neither a local branch nor a fetched remote branch in this repository. Fetch it with a Git fetch operation (the Git panel's Fetch, or POST /api/git/network-operations), then retry`,
    409,
  );
};

export const resolveWorktreeInput = (payload: WorktreeRequestPayload): WorktreeInput | null => {
  if (!isWorktreeFields(payload?.worktree)) return null;
  const fields = payload.worktree;
  const existingBranch = asNonEmptyString(fields.existingBranch);
  if (fields.existingBranch !== undefined && !existingBranch) {
    throw new OpenChamberControlError('worktree.existingBranch must be a non-empty branch name', 400);
  }
  const name = asNonEmptyString(fields.name);
  if (!name) {
    if (existingBranch) {
      throw new OpenChamberControlError('worktree.existingBranch needs worktree.name: pass the folder name for the worktree that checks the branch out', 400);
    }
    return null;
  }
  const branchName = asNonEmptyString(fields.branchName);
  const startRef = asNonEmptyString(fields.startRef);
  if (existingBranch && (branchName || startRef)) {
    throw new OpenChamberControlError('existingBranch checks out that branch as it is; do not combine it with branch or startRef', 400);
  }
  const input: WorktreeInput = existingBranch
    ? { mode: 'existing', name, existingBranch }
    : { mode: 'new', name };
  if (branchName) input.branchName = branchName;
  if (startRef) input.startRef = startRef;
  if (isBoolean(payload.setUpstream)) input.setUpstream = payload.setUpstream;
  return input;
};
