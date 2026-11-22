/**
 * The draft's "Auto-create worktree" switch: the first prompt of a new session
 * gets its own worktree before the session is created.
 *
 * The composer starts it right before the send and marks the draft with a
 * pending worktree request; draft materialization already waits on that
 * request, so the session is created in the new worktree. Naming is a
 * convenience and never blocks: a failed or empty generated name falls back to
 * the random name Quick worktree uses. A failed creation fails the send, so the
 * prompt returns to the composer instead of running in the project root.
 *
 * The new branch starts where the draft's source picker says, else where
 * Settings say for Auto-create worktree. A pull request as the source is read
 * again at send time so the worktree gets its current head. Checking out its
 * branch makes a typed name name only the folder; branching off it names the
 * new branch like any other auto-created worktree.
 */

import { z } from 'zod';

import { resolvePrWorktreeConfig } from '@/components/session/prWorktreeConfig';
import type { GitBranch, SourceControlAPI } from '@/lib/api/types';
import { generateBranchName } from '@/lib/git/branchNameGenerator';
import { getGitBranches } from '@/lib/gitApi';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { normalizePath } from '@/lib/pathNormalization';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import { readSourceControlProvider } from '@/lib/source-control/providers/registry';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { resolveWorktreeSetupCommands } from '@/lib/sharedTrustConfirmation';
import {
  createPendingDraftWorktreeRequest,
  rejectPendingDraftWorktreeRequest,
  resolvePendingDraftWorktreeRequest,
} from '@/lib/worktrees/pendingDraftWorktree';
import {
  createWorktreeWithDefaults,
  resolveDefaultWorktreeStartRef,
  WorktreeRequiresGitRepositoryError,
} from '@/lib/worktrees/worktreeCreate';
import type { CreateWorktreeArgs, ProjectRef } from '@/lib/worktrees/worktreeManager';
import { branchNameFromTemplate, uniqueBranchName } from '@/lib/worktrees/branchNameTemplate';
import type { WorktreeStartFrom, WorktreeStartSource } from '@/lib/worktrees/worktreeStartSource';
import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';

/** Long enough for a small model's reply, short enough that a stuck one costs only a pause. */
const NAME_GENERATION_TIMEOUT_MS = 15_000;

type AutoWorktreeTarget =
  | { kind: 'path'; path: string }
  | { kind: 'name'; name: string }
  | { kind: 'generate' };

/** What the optional name field asks for: an exact path, a name, or a name made from the prompt. */
export const parseAutoWorktreeName = (typed: string | undefined): AutoWorktreeTarget => {
  const value = typed?.trim() ?? '';
  if (!value) return { kind: 'generate' };
  if (value.startsWith('/')) return { kind: 'path', path: value };
  return { kind: 'name', name: value };
};

/**
 * A plain name is the directory under the worktree root, like Quick worktree;
 * an exact path is the checkout itself. The branch is named from either by a
 * Settings template (`branchNameFor`).
 */
export const toAutoWorktreeCreateArgs = (
  target: Exclude<AutoWorktreeTarget, { kind: 'generate' }>,
  branchName: string,
): Pick<CreateWorktreeArgs, 'preferredName' | 'branchName' | 'worktreeName'> => (
  target.kind === 'path'
    ? { worktreeName: target.path, branchName }
    : { preferredName: target.name, branchName, worktreeName: target.name }
);

/**
 * The branch for a named worktree: the template filled with its name made fit
 * for a branch (a path's last segment), and a `-2`, `-3`… suffix when a local
 * branch already has the name, so two prompts that name the same task still
 * get two branches.
 */
export const branchNameFor = (
  target: Exclude<AutoWorktreeTarget, { kind: 'generate' }>,
  template: string,
  localBranches: ReadonlySet<string>,
  pullRequest?: { pr: number; head: string },
): string => {
  const name = target.kind === 'path' ? target.path : target.name;
  return uniqueBranchName(branchNameFromTemplate(template, { name, ...pullRequest }), localBranches);
};

/**
 * A pull request worktree checks out the request's own branch, as the New
 * worktree dialog does. A typed name or path names only the folder; without
 * one the folder is named after the branch.
 */
export const toPullRequestWorktreeArgs = (
  config: ReturnType<typeof resolvePrWorktreeConfig>,
  target: AutoWorktreeTarget,
): CreateWorktreeArgs => {
  const folder = target.kind === 'path' ? target.path : target.kind === 'name' ? target.name : config.sourceLabel;
  return {
    mode: 'existing',
    preferredName: folder,
    branchName: config.sourceLabel,
    worktreeName: folder,
    existingBranch: config.existingBranch,
    expectedRevision: config.expectedRevision,
    changeRequestSource: config.changeRequestSource,
  };
};

/**
 * A new branch from a pull request's head is named by the pull request branch
 * template; the server starts it at the head it resolves from the request.
 */
export const toPullRequestBranchOffArgs = (
  config: ReturnType<typeof resolvePrWorktreeConfig>,
  target: Exclude<AutoWorktreeTarget, { kind: 'generate' }>,
  branchName: string,
): CreateWorktreeArgs => ({
  mode: 'new',
  ...toAutoWorktreeCreateArgs(target, branchName),
  changeRequestSource: config.changeRequestSource,
});

/**
 * The switch applies only to a project draft still aimed at the project root
 * of a git repository: a draft that already targets a worktree (Quick
 * worktree, the New Worktree dialog, a selected worktree) or a space keeps it.
 */
export const shouldAutoCreateDraftWorktree = ({ enabled, draft, projectPath, isGitRepo }: {
  enabled: boolean;
  draft: Pick<NewSessionDraftState, 'open' | 'target' | 'directoryOverride' | 'pendingWorktreeRequestId' | 'bootstrapPendingDirectory'>;
  projectPath: string | null;
  isGitRepo: boolean | null;
}): boolean => {
  if (!enabled || !draft.open || draft.target !== 'project' || isGitRepo !== true) return false;
  if (draft.pendingWorktreeRequestId || draft.bootstrapPendingDirectory) return false;
  const root = normalizePath(projectPath);
  if (!root) return false;
  return (normalizePath(draft.directoryOverride) ?? root) === root;
};

const GeneratedNameResponse = z.object({ name: z.string() });

/** A name made from the prompt by the given model, or '' when none could be made. */
export const generateAutoWorktreeName = async (
  projectDirectory: string,
  prompt: string,
  model: string,
): Promise<string> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAME_GENERATION_TIMEOUT_MS);
  try {
    const response = await runtimeFetch('/api/git/worktrees/generate-name', {
      method: 'POST',
      query: { directory: projectDirectory },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model }),
      signal: controller.signal,
    });
    if (!response.ok) return '';
    const parsed = GeneratedNameResponse.safeParse(await response.json());
    return parsed.success ? parsed.data.name.trim() : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
};

const resolveNamedTarget = async (
  target: AutoWorktreeTarget,
  generate: () => Promise<string>,
): Promise<Exclude<AutoWorktreeTarget, { kind: 'generate' }>> => {
  if (target.kind !== 'generate') return target;
  const generated = await generate();
  return { kind: 'name', name: generated || generateBranchName() };
};

const pullRequestWorktreeArgs = async ({ source, target, sourceControl, generateName, branches, template }: {
  source: Extract<WorktreeStartSource, { kind: 'pull-request' }>;
  target: AutoWorktreeTarget;
  sourceControl: Pick<SourceControlAPI, 'changeRequestContext'>;
  generateName: () => Promise<string>;
  /** Local branches only: they decide whether the request's branch is already here. */
  branches: GitBranch;
  template: string;
}): Promise<CreateWorktreeArgs> => {
  const { changeRequest } = await sourceControl.changeRequestContext(source.context, source.number, {
    includeDiff: false,
    includeCIDetails: false,
  });
  if (!changeRequest) {
    throw new Error(formatMessage(useI18nStore.getState().dictionary, 'chat.chatInput.autoWorktree.source.notFound', {
      reference: formatChangeRequestReference(readSourceControlProvider(source.context.provider), source.number),
    }));
  }
  const config = resolvePrWorktreeConfig(changeRequest, source.context, branches.branches ?? {});
  if (!source.branchOff) return toPullRequestWorktreeArgs(config, target);
  const named = await resolveNamedTarget(target, generateName);
  const branchName = branchNameFor(named, template, localBranchNames(branches), { pr: source.number, head: config.sourceLabel });
  return toPullRequestBranchOffArgs(config, named, branchName);
};

const localBranchNames = (branches: GitBranch): Set<string> => new Set(branches.all.filter((name) => !name.startsWith('remotes/')));

/**
 * Starts the worktree for a draft that is about to send and returns the
 * pending request the draft now waits on. The live draft is marked too, so the
 * target selector shows the worktree being made and cannot be changed under it.
 */
export const startAutoDraftWorktree = ({ project, prompt, model, typedName, source, startFrom, branchTemplates, sourceControl, fallbackDirectory }: {
  project: ProjectRef;
  prompt: string;
  /** `providerID/modelID` the first prompt is sent with; it also names the worktree. */
  model: string;
  typedName: string | undefined;
  /** Picked beside the switch for this project; undefined means the Settings default. */
  source: WorktreeStartSource | undefined;
  startFrom: WorktreeStartFrom;
  /** Settings templates that name the new branch. */
  branchTemplates: { worktree: string; pullRequest: string };
  /** Reads a pull request source as it is now. */
  sourceControl: Pick<SourceControlAPI, 'changeRequestContext'>;
  /** Where the draft pointed before, restored when no worktree could be made. */
  fallbackDirectory: string;
}): string => {
  const requestId = createPendingDraftWorktreeRequest();
  useSessionUIStore.getState().setPendingDraftWorktreeRequest(requestId);

  void (async () => {
    try {
      const target = parseAutoWorktreeName(typedName);
      const generateName = () => generateAutoWorktreeName(project.path, prompt, model);
      const branches = await getGitBranches(project.path, { remote: 'local' });
      let args: CreateWorktreeArgs;
      if (source?.kind === 'pull-request') {
        args = await pullRequestWorktreeArgs({ source, target, sourceControl, generateName, branches, template: branchTemplates.pullRequest });
      } else {
        const named = await resolveNamedTarget(target, generateName);
        args = {
          mode: 'new',
          ...toAutoWorktreeCreateArgs(named, branchNameFor(named, branchTemplates.worktree, localBranchNames(branches))),
          startRef: source?.kind === 'ref' ? source.ref : await resolveDefaultWorktreeStartRef(project.path, startFrom),
        };
      }
      const setupCommands = await resolveWorktreeSetupCommands(project);
      const metadata = await createWorktreeWithDefaults(project, {
        ...args,
        setupCommands,
        returnAfterDirectoryCreated: true,
      });
      resolvePendingDraftWorktreeRequest(requestId, metadata.path, { keep: true });
    } catch (error) {
      // Not a repository after all: the switch has nothing to do, the session starts where it was aimed.
      if (error instanceof WorktreeRequiresGitRepositoryError) {
        resolvePendingDraftWorktreeRequest(requestId, fallbackDirectory, { keep: true });
        return;
      }
      rejectPendingDraftWorktreeRequest(requestId, error instanceof Error ? error : new Error(String(error)), { keep: true });
      useSessionUIStore.getState().resolvePendingDraftWorktreeTarget(requestId, fallbackDirectory, { preserveDirectoryOverride: false });
    }
  })();

  return requestId;
};
