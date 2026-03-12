

import type { RuntimeAPIs } from './api/types';
import * as gitHttp from './gitApiHttp';
import { opencodeClient } from './opencode/client';
import { useSessionStore } from '@/stores/useSessionStore';
import { useContextStore } from '@/stores/contextStore';
import { useConfigStore } from '@/stores/useConfigStore';

export type {
  GitStatus,
  GitDiffResponse,
  GetGitDiffOptions,
  GitBranchDetails,
  GitBranch,
  GitCommitResult,
  GitPushResult,
  GitPullResult,
  GitIdentityProfile,
  GitIdentityAuthType,
  GitIdentitySummary,
  GitLogEntry,
  GitLogResponse,
  GitWorktreeInfo,
  CreateGitWorktreePayload,
  GitWorktreeCreateResult,
  RemoveGitWorktreePayload,
  GitWorktreeValidationError,
  GitWorktreeValidationResult,
  GitDeleteBranchPayload,
  GitDeleteRemoteBranchPayload,
  DiscoveredGitCredential,
  GitRemote,
  GitMergeResult,
  GitRebaseResult,
  MergeConflictDetails,
} from './api/types';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

const getRuntimeGit = () => {
  if (typeof window !== 'undefined' && window.__OPENCHAMBER_RUNTIME_APIS__?.git) {
    return window.__OPENCHAMBER_RUNTIME_APIS__.git;
  }
  return null;
};

export async function checkIsGitRepository(directory: string): Promise<boolean> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.checkIsGitRepository(directory);
  return gitHttp.checkIsGitRepository(directory);
}

export async function getGitStatus(directory: string): Promise<import('./api/types').GitStatus> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitStatus(directory);
  return gitHttp.getGitStatus(directory);
}

export async function getGitDiff(directory: string, options: import('./api/types').GetGitDiffOptions): Promise<import('./api/types').GitDiffResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitDiff(directory, options);
  return gitHttp.getGitDiff(directory, options);
}

export async function getGitFileDiff(
  directory: string,
  options: import('./api/types').GetGitFileDiffOptions
): Promise<import('./api/types').GitFileDiffResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitFileDiff(directory, options);
  return gitHttp.getGitFileDiff(directory, options);
}

export async function revertGitFile(directory: string, filePath: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.revertGitFile(directory, filePath);
  return gitHttp.revertGitFile(directory, filePath);
}

export async function isLinkedWorktree(directory: string): Promise<boolean> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.isLinkedWorktree(directory);
  return gitHttp.isLinkedWorktree(directory);
}

export async function getGitBranches(directory: string): Promise<import('./api/types').GitBranch> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitBranches(directory);
  return gitHttp.getGitBranches(directory);
}

export async function deleteGitBranch(directory: string, payload: import('./api/types').GitDeleteBranchPayload): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteGitBranch(directory, payload);
  return gitHttp.deleteGitBranch(directory, payload);
}

export async function deleteRemoteBranch(directory: string, payload: import('./api/types').GitDeleteRemoteBranchPayload): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteRemoteBranch(directory, payload);
  return gitHttp.deleteRemoteBranch(directory, payload);
}

export async function generateCommitMessage(
  directory: string,
  files: string[],
  options?: { zenModel?: string; providerId?: string; modelId?: string }
): Promise<{ message: import('./api/types').GeneratedCommitMessage }> {
  const startedAt = Date.now();
  void options;
  const generationSession = resolveSessionGenerationContext();

  if (!generationSession) {
    throw new Error('Select existing session for generation');
  }

  console.info('[git-generation][browser] request', {
    transport: 'session',
    kind: 'commit',
    directory,
    selectedFiles: files.length,
    sessionId: generationSession.sessionId,
    providerId: generationSession.providerID,
    modelId: generationSession.modelID,
    agent: generationSession.agent,
  });

  const prompt = `You are generating a Conventional Commits subject line using session context and selected file paths.

Return JSON with exactly this shape:
{"subject": string, "highlights": string[]}

Rules:
- subject format: <type>: <summary>
- allowed types: feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert
- no scope in subject
- keep subject concise and user-facing
- highlights: 0-3 concise user-facing points

Selected files:
${files.map((file) => `- ${file}`).join('\n')}`;

  try {
    const structured = await runStructuredGenerationInActiveSession({
      directory,
      prompt,
      generationSession,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subject: { type: 'string', description: 'Conventional commit subject line.' },
          highlights: {
            type: 'array',
            items: { type: 'string', description: 'Short user-facing highlight.' },
            maxItems: 3,
            description: 'Optional short user-facing highlights.',
          },
        },
        required: ['subject', 'highlights'],
      },
      kind: 'commit',
    });

    const subject = typeof structured.subject === 'string' ? structured.subject.trim() : '';
    const highlights = Array.isArray(structured.highlights)
      ? structured.highlights.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 3)
      : [];

    if (!subject) {
      throw new Error('Structured output missing subject');
    }

    const result = { message: { subject, highlights } };
    console.info('[git-generation][browser] success', {
      transport: 'session',
      kind: 'commit',
      elapsedMs: Date.now() - startedAt,
      subjectLength: result.message.subject.length,
      highlightsCount: result.message.highlights.length,
    });
    return result;
  } catch (error) {
    console.error('[git-generation][browser] failed', {
      transport: 'session',
      kind: 'commit',
      elapsedMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
      error,
    });
    throw error;
  }
}

export async function generatePullRequestDescription(
  directory: string,
  payload: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string }
): Promise<import('./api/types').GeneratedPullRequestDescription> {
  const startedAt = Date.now();
  const generationSession = resolveSessionGenerationContext();
  if (!generationSession) {
    throw new Error('Select existing session for generation');
  }

  const commitLog = await getGitLog(directory, {
    from: payload.base,
    to: payload.head,
    maxCount: 50,
  });
  const commits = (Array.isArray(commitLog?.all) ? commitLog.all : [])
    .filter((entry) => typeof entry?.hash === 'string' && entry.hash.length > 0)
    .map((entry) => ({
      hash: entry.hash,
      subject: typeof entry.message === 'string' ? entry.message.trim() : '',
    }));

  if (commits.length === 0) {
    throw new Error(`No commits found in range ${payload.base}...${payload.head}`);
  }

  const filesSet = new Set<string>();
  await Promise.all(commits.map(async (commit) => {
    try {
      const response = await getCommitFiles(directory, commit.hash);
      const files = Array.isArray(response?.files) ? response.files : [];
      for (const file of files) {
        if (typeof file?.path === 'string' && file.path.trim().length > 0) {
          filesSet.add(file.path.trim());
        }
      }
    } catch (error) {
      console.warn('[git-generation][browser] failed to collect commit files', {
        hash: commit.hash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));
  const changedFiles = Array.from(filesSet).sort().slice(0, 300);

  console.info('[git-generation][browser] request', {
    transport: 'session',
    kind: 'pr',
    directory,
    sessionId: generationSession.sessionId,
    providerId: generationSession.providerID,
    modelId: generationSession.modelID,
    agent: generationSession.agent,
    base: payload.base,
    head: payload.head,
    commits: commits.length,
    changedFiles: changedFiles.length,
  });

  const prompt = `You are drafting GitHub Pull Request title and body using session context, commit list, and changed files.

Return JSON with exactly this shape:
{"title": string, "body": string}

Rules:
- title: concise, outcome-first, conventional style
- body: markdown with sections: ## Summary, ## Why, ## Testing
- keep output concrete and user-facing

Base branch: ${payload.base}
Head branch: ${payload.head}

Commits in range (base...head):
${commits.map((commit) => `- ${commit.hash.slice(0, 7)} ${commit.subject || '(no subject)'}`).join('\n')}

Files changed across these commits:
${changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`).join('\n') : '- none detected'}
${payload.context?.trim() ? `\nAdditional context:\n${payload.context.trim()}` : ''}`;

  try {
    const structured = await runStructuredGenerationInActiveSession({
      directory,
      prompt,
      generationSession,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Pull request title.' },
          body: { type: 'string', description: 'Pull request markdown description.' },
        },
        required: ['title', 'body'],
      },
      kind: 'pr',
    });

    const result = {
      title: typeof structured.title === 'string' ? structured.title.trim() : '',
      body: typeof structured.body === 'string' ? structured.body.trim() : '',
    };
    console.info('[git-generation][browser] success', {
      transport: 'session',
      kind: 'pr',
      elapsedMs: Date.now() - startedAt,
      titleLength: result.title.length,
      bodyLength: result.body.length,
    });
    return result;
  } catch (error) {
    console.error('[git-generation][browser] failed', {
      transport: 'session',
      kind: 'pr',
      elapsedMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
      error,
    });
    throw error;
  }
}

type SessionGenerationContext = {
  sessionId: string;
  providerID: string;
  modelID: string;
  agent?: string;
};

const resolveSessionGenerationContext = (): SessionGenerationContext | null => {
  const sessionId = useSessionStore.getState().currentSessionId;
  if (!sessionId) {
    return null;
  }

  const context = useContextStore.getState();
  const config = useConfigStore.getState();

  const agent = context.getSessionAgentSelection(sessionId) || config.currentAgentName || undefined;
  const sessionModel = context.getSessionModelSelection(sessionId);
  const agentModel = agent ? context.getAgentModelForSession(sessionId, agent) : null;
  const selectedModel = agentModel || sessionModel || (config.currentProviderId && config.currentModelId
    ? { providerId: config.currentProviderId, modelId: config.currentModelId }
    : null);

  if (!selectedModel?.providerId || !selectedModel?.modelId) {
    return null;
  }

  return {
    sessionId,
    providerID: selectedModel.providerId,
    modelID: selectedModel.modelId,
    agent,
  };
};

const runStructuredGenerationInActiveSession = async ({
  directory,
  prompt,
  generationSession,
  schema,
  kind,
}: {
  directory: string;
  prompt: string;
  generationSession: SessionGenerationContext;
  schema: Record<string, unknown>;
  kind: 'commit' | 'pr';
}): Promise<Record<string, unknown>> => {
  const requestStartedAt = Date.now();
  console.info('[git-generation][browser] runStructuredGenerationInActiveSession start', {
    kind,
    directory,
    sessionId: generationSession.sessionId,
    providerID: generationSession.providerID,
    modelID: generationSession.modelID,
    agent: generationSession.agent,
  });
  const trimmedDirectory = typeof directory === 'string' ? directory.trim() : '';
  const firstNewlineIndex = prompt.indexOf('\n');
  const visiblePrompt = (firstNewlineIndex === -1 ? prompt : prompt.slice(0, firstNewlineIndex)).trim();
  const hiddenPrompt = (firstNewlineIndex === -1 ? '' : prompt.slice(firstNewlineIndex + 1)).trim();
  const promptParts: Array<{ type: 'text'; text: string; synthetic?: boolean }> = [];
  if (visiblePrompt) {
    promptParts.push({ type: 'text', text: visiblePrompt, synthetic: false });
  }
  if (hiddenPrompt) {
    promptParts.push({ type: 'text', text: hiddenPrompt, synthetic: true });
  }
  if (promptParts.length === 0) {
    promptParts.push({ type: 'text', text: prompt, synthetic: false });
  }

  const response = await opencodeClient.withDirectory(directory, async () => {
    return opencodeClient.getApiClient().session.prompt({
      sessionID: generationSession.sessionId,
      ...(trimmedDirectory.length > 0 ? { directory: trimmedDirectory } : {}),
      model: {
        providerID: generationSession.providerID,
        modelID: generationSession.modelID,
      },
      ...(generationSession.agent ? { agent: generationSession.agent } : {}),
      format: {
        type: 'json_schema',
        schema,
        retryCount: 2,
      },
      parts: promptParts,
    });
  });

  const responseError = response?.error as { message?: string } | undefined;
  if (!response?.data) {
    throw new Error(responseError?.message || `Failed to generate ${kind} output`);
  }

  const info = response.data.info as { finish?: string; structured_output?: unknown; structured?: unknown; error?: unknown };
  const structuredOutput = info?.structured_output || info?.structured;
  if (!structuredOutput || typeof structuredOutput !== 'object' || Array.isArray(structuredOutput)) {
    console.error('[git-generation][browser] invalid structured output', {
      kind,
      sessionId: generationSession.sessionId,
      elapsedMs: Date.now() - requestStartedAt,
      finish: info?.finish,
      messageInfo: response.data.info,
      messageParts: response.data.parts,
    });
    throw new Error('No structured output returned by session');
  }

  return structuredOutput as Record<string, unknown>;
};

export async function listGitWorktrees(directory: string): Promise<import('./api/types').GitWorktreeInfo[]> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.list) {
    return runtime.worktree.list(directory);
  }
  if (runtime) return runtime.listGitWorktrees(directory);
  return gitHttp.listGitWorktrees(directory);
}

export async function validateGitWorktree(
  directory: string,
  payload: import('./api/types').CreateGitWorktreePayload
): Promise<import('./api/types').GitWorktreeValidationResult> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.validate) {
    return runtime.worktree.validate(directory, payload);
  }
  if (runtime?.validateGitWorktree) {
    return runtime.validateGitWorktree(directory, payload);
  }
  return gitHttp.validateGitWorktree(directory, payload);
}

export async function createGitWorktree(
  directory: string,
  payload: import('./api/types').CreateGitWorktreePayload
): Promise<import('./api/types').GitWorktreeCreateResult> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.create) {
    return runtime.worktree.create(directory, payload);
  }
  if (runtime?.createGitWorktree) {
    return runtime.createGitWorktree(directory, payload);
  }
  return gitHttp.createGitWorktree(directory, payload);
}

export async function deleteGitWorktree(
  directory: string,
  payload: import('./api/types').RemoveGitWorktreePayload
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.remove) {
    return runtime.worktree.remove(directory, payload);
  }
  if (runtime?.deleteGitWorktree) {
    return runtime.deleteGitWorktree(directory, payload);
  }
  return gitHttp.deleteGitWorktree(directory, payload);
}

export const git = {
  worktree: {
    list: listGitWorktrees,
    validate: validateGitWorktree,
    create: createGitWorktree,
    remove: deleteGitWorktree,
  },
};

export async function createGitCommit(
  directory: string,
  message: string,
  options: import('./api/types').CreateGitCommitOptions = {}
): Promise<import('./api/types').GitCommitResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createGitCommit(directory, message, options);
  return gitHttp.createGitCommit(directory, message, options);
}

export async function gitPush(
  directory: string,
  options: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> } = {}
): Promise<import('./api/types').GitPushResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitPush(directory, options);
  return gitHttp.gitPush(directory, options);
}

export async function gitPull(
  directory: string,
  options: { remote?: string; branch?: string } = {}
): Promise<import('./api/types').GitPullResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitPull(directory, options);
  return gitHttp.gitPull(directory, options);
}

export async function gitFetch(
  directory: string,
  options: { remote?: string; branch?: string } = {}
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitFetch(directory, options);
  return gitHttp.gitFetch(directory, options);
}

export async function checkoutBranch(directory: string, branch: string): Promise<{ success: boolean; branch: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.checkoutBranch(directory, branch);
  return gitHttp.checkoutBranch(directory, branch);
}

export async function createBranch(
  directory: string,
  name: string,
  startPoint?: string
): Promise<{ success: boolean; branch: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createBranch(directory, name, startPoint);
  return gitHttp.createBranch(directory, name, startPoint);
}

export async function renameBranch(
  directory: string,
  oldName: string,
  newName: string
): Promise<{ success: boolean; branch: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.renameBranch(directory, oldName, newName);
  return gitHttp.renameBranch(directory, oldName, newName);
}

export async function getGitLog(
  directory: string,
  options: import('./api/types').GitLogOptions = {}
): Promise<import('./api/types').GitLogResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitLog(directory, options);
  return gitHttp.getGitLog(directory, options);
}

export async function getCommitFiles(
  directory: string,
  hash: string
): Promise<import('./api/types').GitCommitFilesResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getCommitFiles(directory, hash);
  return gitHttp.getCommitFiles(directory, hash);
}

export async function getGitIdentities(): Promise<import('./api/types').GitIdentityProfile[]> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitIdentities();
  return gitHttp.getGitIdentities();
}

export async function createGitIdentity(profile: import('./api/types').GitIdentityProfile): Promise<import('./api/types').GitIdentityProfile> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createGitIdentity(profile);
  return gitHttp.createGitIdentity(profile);
}

export async function updateGitIdentity(id: string, updates: import('./api/types').GitIdentityProfile): Promise<import('./api/types').GitIdentityProfile> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.updateGitIdentity(id, updates);
  return gitHttp.updateGitIdentity(id, updates);
}

export async function deleteGitIdentity(id: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteGitIdentity(id);
  return gitHttp.deleteGitIdentity(id);
}

export async function getCurrentGitIdentity(directory: string): Promise<import('./api/types').GitIdentitySummary | null> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getCurrentGitIdentity(directory);
  return gitHttp.getCurrentGitIdentity(directory);
}

export async function hasLocalIdentity(directory: string): Promise<boolean> {
  const runtime = getRuntimeGit();
  if (runtime?.hasLocalIdentity) return runtime.hasLocalIdentity(directory);
  return gitHttp.hasLocalIdentity(directory);
}

export async function setGitIdentity(
  directory: string,
  profileId: string
): Promise<{ success: boolean; profile: import('./api/types').GitIdentityProfile }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.setGitIdentity(directory, profileId);
  return gitHttp.setGitIdentity(directory, profileId);
}

export async function discoverGitCredentials(): Promise<import('./api/types').DiscoveredGitCredential[]> {
  const runtime = getRuntimeGit();
  if (runtime?.discoverGitCredentials) return runtime.discoverGitCredentials();
  return gitHttp.discoverGitCredentials();
}

export async function getGlobalGitIdentity(): Promise<import('./api/types').GitIdentitySummary | null> {
  const runtime = getRuntimeGit();
  if (runtime?.getGlobalGitIdentity) return runtime.getGlobalGitIdentity();
  return gitHttp.getGlobalGitIdentity();
}

export async function getRemoteUrl(directory: string, remote?: string): Promise<string | null> {
  const runtime = getRuntimeGit();
  if (runtime?.getRemoteUrl) return runtime.getRemoteUrl(directory, remote);
  return gitHttp.getRemoteUrl(directory, remote);
}

export async function getRemotes(directory: string): Promise<import('./api/types').GitRemote[]> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getRemotes(directory);
  return gitHttp.getRemotes(directory);
}

export async function rebase(
  directory: string,
  options: { onto: string }
): Promise<import('./api/types').GitRebaseResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.rebase(directory, options);
  return gitHttp.rebase(directory, options);
}

export async function abortRebase(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.abortRebase(directory);
  return gitHttp.abortRebase(directory);
}

export async function merge(
  directory: string,
  options: { branch: string }
): Promise<import('./api/types').GitMergeResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.merge(directory, options);
  return gitHttp.merge(directory, options);
}

export async function abortMerge(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.abortMerge(directory);
  return gitHttp.abortMerge(directory);
}

export async function continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.continueRebase(directory);
  return gitHttp.continueRebase(directory);
}

export async function continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.continueMerge(directory);
  return gitHttp.continueMerge(directory);
}

export async function stash(
  directory: string,
  options?: { message?: string; includeUntracked?: boolean }
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stash(directory, options);
  return gitHttp.stash(directory, options);
}

export async function stashPop(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stashPop(directory);
  return gitHttp.stashPop(directory);
}

export async function getConflictDetails(directory: string): Promise<import('./api/types').MergeConflictDetails> {
  const runtime = getRuntimeGit();
  if (runtime?.getConflictDetails) return runtime.getConflictDetails(directory);
  return gitHttp.getConflictDetails(directory);
}
