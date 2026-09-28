import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
import type { GitWorktreeSnapshotResult } from '@/lib/api/types';
import { getGitRangeDiff, snapshotGitWorktree } from '@/lib/gitApi';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { getWorktreeSetupWaitEnabled } from '@/lib/openchamberConfig';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveWorktreeSetupCommands } from '@/lib/sharedTrustConfirmation';
import { waitForWorktreeBootstrap } from '@/lib/worktrees/worktreeBootstrap';
import { createWorktreeWithDefaults } from '@/lib/worktrees/worktreeCreate';
import { registerMultiRunSession } from '@/stores/useMultiRunStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { createMultiRunSession } from './createSession';
import { getMultiRunIdentity, type MultiRunIdentity } from './identity';
import { resolveRunMemberLocation, runSnapshotRef, type RunMemberLocation } from './keep';
import { loadLaneDiffStat, loadLaneFirstPrompt, loadLaneLastReply, type LaneDiffStat } from './laneData';
import { multiRunVariantLabel, type MultiRunSummary } from './runs';

export type FusionJudge = {
  providerID: string;
  modelID: string;
  variant?: string;
  agent?: string;
  /** Display name for the fusion session title. */
  modelName?: string;
  /** Context window of the judge model, when the provider reports it. */
  contextLimit?: number;
};

export type FusionMode = 'answers' | 'code';

export class NoFusionOutputsError extends Error {
  constructor() {
    super('No assistant outputs to fuse');
    this.name = 'NoFusionOutputsError';
  }
}

type FusionSource = {
  session: Session;
  identity: MultiRunIdentity;
  label: string;
  reply: string;
  location: RunMemberLocation | null;
};

// Diffs are inlined only while all of them together stay under this share of
// the judge's context window; otherwise the judge reads them with git.
const INLINE_DIFF_CONTEXT_SHARE = 0.1;
// Rough token cost of one changed line (content plus diff framing).
const TOKENS_PER_DIFF_LINE = 12;

/** Selected lanes whose worktrees hold changes and who all have one: that is a code fusion. */
export const fusionModeFor = (stats: ReadonlyArray<{ hasWorktree: boolean; diff: LaneDiffStat | null }>): FusionMode => (
  stats.length > 0 && stats.every((entry) => entry.hasWorktree) && stats.some((entry) => (entry.diff?.files ?? 0) > 0)
    ? 'code'
    : 'answers'
);

/** Whether every diff together fits in the inline budget of the judge's context window. */
export const shouldInlineDiffs = (changedLines: number, contextLimit: number | undefined): boolean => (
  contextLimit !== undefined && contextLimit > 0
  && changedLines * TOKENS_PER_DIFF_LINE <= contextLimit * INLINE_DIFF_CONTEXT_SHARE
);

const laneLabel = (identity: MultiRunIdentity, variantCount: number): string => {
  const variant = variantCount > 1 ? ` · ${multiRunVariantLabel(identity.runGroup)}` : '';
  const index = identity.index && identity.index > 1 ? ` #${identity.index}` : '';
  return `${identity.providerID}/${identity.modelID}${index}${variant}`;
};

/**
 * Revalidates each selected lane and reads its latest reply. A read failure
 * stops the fusion rather than silently dropping a source; a lane that has
 * not answered is left out.
 */
async function loadFusionSources(
  run: MultiRunSummary,
  sourceIds: readonly string[],
  sessionById: ReadonlyMap<string, Session>,
  assertCurrent: () => void,
): Promise<FusionSource[]> {
  const sources = await Promise.all(sourceIds.map(async (sessionId): Promise<FusionSource | null> => {
    const cached = sessionById.get(sessionId);
    if (!cached) throw new Error('Fusion source membership changed');
    const session = await opencodeClient.getSession(sessionId, cached.directory);
    assertCurrent();
    const location = await resolveRunMemberLocation(session, run);
    assertCurrent();
    const identity = getMultiRunIdentity(session, location?.project.path ?? session.directory);
    if (!identity || identity.key !== run.key || identity.role !== 'run') {
      throw new Error('Fusion source membership changed');
    }
    const reply = await loadLaneLastReply(sessionId, session.directory);
    assertCurrent();
    if (!reply) return null;
    return { session, identity, label: laneLabel(identity, run.variants.length), reply, location };
  }));
  return sources.filter((source): source is FusionSource => source !== null);
}

async function loadVariantPrompts(sources: readonly FusionSource[], assertCurrent: () => void): Promise<Map<string, string>> {
  const firstByVariant = new Map<string, FusionSource>();
  for (const source of sources) {
    const variant = multiRunVariantLabel(source.identity.runGroup);
    if (!firstByVariant.has(variant)) firstByVariant.set(variant, source);
  }
  const prompts = new Map<string, string>();
  for (const [variant, source] of firstByVariant) {
    const prompt = await loadLaneFirstPrompt(source.session.id, source.session.directory);
    assertCurrent();
    if (prompt?.text) prompts.set(variant, prompt.text);
  }
  return prompts;
}

const taskBlocks = (prompts: ReadonlyMap<string, string>): string[] => (
  Array.from(prompts, ([variant, text]) => (
    prompts.size > 1
      ? `\n\n--- TASK (variant ${variant}) ---\n${text.trim()}\n--- END TASK ---`
      : `\n\n--- TASK ---\n${text.trim()}\n--- END TASK ---`
  ))
);

/**
 * Starts a fusion session for the selected lanes and opens it. Answers mode
 * fuses the lanes' final replies in the project directory. Code mode snapshots
 * every lane, gives the judge its own worktree at the lanes' starting commit
 * and a manifest (answers, diffstats, snapshot commits), inlining the diffs
 * only when they are small next to the judge's context window.
 */
export async function startRunFusion(input: {
  run: MultiRunSummary;
  sourceIds: readonly string[];
  judge: FusionJudge;
  sessionById: ReadonlyMap<string, Session>;
}): Promise<{ sessionId: string; directory: string; mode: FusionMode }> {
  const { run, judge } = input;
  const runtimeKey = getRuntimeKey();
  const client = opencodeClient.getSdkClient();
  const assertCurrent = () => {
    if (getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== client) throw new Error('Runtime changed');
  };

  const sources = await loadFusionSources(run, input.sourceIds, input.sessionById, assertCurrent);
  if (sources.length === 0) throw new NoFusionOutputsError();
  const diffs = await Promise.all(sources.map(async (source) => (
    source.location?.worktree ? loadLaneDiffStat(source.location.worktree.path) : null
  )));
  assertCurrent();
  const mode = fusionModeFor(sources.map((source, index) => ({ hasWorktree: Boolean(source.location?.worktree), diff: diffs[index] })));
  const prompts = await loadVariantPrompts(sources, assertCurrent);
  const project = sources.find((source) => source.location)?.location?.project ?? null;
  const first = sources[0];
  const projectDirectory = project?.path ?? first.session.directory;

  let directory = projectDirectory;
  const context: Array<{ text: string }> = [];
  let createdWorktree: Awaited<ReturnType<typeof createWorktreeWithDefaults>> | null = null;

  if (mode === 'code' && project) {
    const snapshots: GitWorktreeSnapshotResult[] = [];
    for (const source of sources) {
      const worktreePath = source.location?.worktree?.path;
      if (!worktreePath) throw new Error('Fusion source has no worktree');
      snapshots.push(await snapshotGitWorktree(worktreePath, { ref: runSnapshotRef(run, source.session.id) }));
      assertCurrent();
    }
    const baseCommit = snapshots[0].head;
    const changedLines = diffs.reduce((total, diff) => total + (diff ? diff.insertions + diff.deletions : 0), 0);
    const inlineDiffs = shouldInlineDiffs(changedLines, judge.contextLimit);
    const diffTexts = inlineDiffs
      ? await Promise.all(snapshots.map((snapshot) => getGitRangeDiff(projectDirectory, { base: snapshot.head, head: snapshot.commit })
        .then((response) => response.diff)))
      : [];
    assertCurrent();

    const setupCommands = await resolveWorktreeSetupCommands(project);
    assertCurrent();
    // A run can be fused more than once; each fusion gets its own branch.
    const worktreeName = `${run.groupSlug}/fusion-${Date.now().toString(36)}`;
    createdWorktree = await createWorktreeWithDefaults(project, {
      preferredName: worktreeName,
      mode: 'new',
      branchName: worktreeName,
      worktreeName,
      startRef: baseCommit,
      setupCommands,
      returnAfterDirectoryCreated: true,
    });
    assertCurrent();
    if (await getWorktreeSetupWaitEnabled(project)) {
      await waitForWorktreeBootstrap(createdWorktree.path);
      assertCurrent();
    }
    directory = createdWorktree.path;

    context.push({ text: await renderMagicPrompt('session.fusion.codeInstructions', {
      baseCommit,
      attemptCount: String(sources.length),
    }) });
    context.push(...taskBlocks(prompts).map((text) => ({ text })));
    sources.forEach((source, index) => {
      const snapshot = snapshots[index];
      const diff = diffs[index];
      const stat = diff ? `${diff.files} files, +${diff.insertions} −${diff.deletions}` : 'unknown';
      const lines = [
        `\n\n--- ATTEMPT ${index + 1}: ${source.label} ---`,
        `Snapshot commit: ${snapshot.commit}`,
        `Started from: ${snapshot.head}`,
        `Changes: ${stat}`,
        'Final answer:',
        source.reply,
      ];
      if (inlineDiffs && diffTexts[index]) lines.push('Diff:', diffTexts[index]);
      lines.push(`--- END ATTEMPT ${index + 1} ---`);
      context.push({ text: lines.join('\n') });
    });
    context.push({ text: '\n\n--- FUSION INPUTS END ---\nNow build the fused result in this worktree.' });
  } else {
    context.push({ text: await renderMagicPrompt('session.fusion.instructions') });
    context.push(...taskBlocks(prompts).map((text) => ({ text })));
    sources.forEach((source, index) => {
      context.push({ text: `\n\n--- RESULT ${index + 1}: ${source.label} ---\n${source.reply}\n--- END RESULT ${index + 1} ---` });
    });
    context.push({ text: '\n\n--- FUSION INPUTS END ---\nNow write the final fused answer.' });
  }
  assertCurrent();

  const visiblePrompt = await renderMagicPrompt('session.fusion.visible');
  assertCurrent();
  const fusionSession = await createMultiRunSession({
    title: `${run.title} · ${judge.modelName ?? judge.modelID}`,
    directory,
    identity: {
      group: first.identity.group,
      groupSlug: first.identity.groupSlug,
      providerID: judge.providerID,
      modelID: judge.modelID,
      role: 'fusion',
      title: run.title,
    },
    selection: { model: { providerID: judge.providerID, id: judge.modelID, variant: judge.variant }, agent: judge.agent },
  }, assertCurrent);
  registerMultiRunSession(fusionSession, directory);
  if (createdWorktree && project) {
    useSessionUIStore.getState().setWorktreeMetadata(fusionSession.id, { ...createdWorktree, kind: 'standard' });
  }

  assertCurrent();
  await opencodeClient.sendMessage({
    runtimeKey,
    id: fusionSession.id,
    providerID: judge.providerID,
    model: { providerID: judge.providerID, id: judge.modelID, variant: judge.variant },
    agent: judge.agent,
    text: visiblePrompt,
    context,
    directory,
  });
  return { sessionId: fusionSession.id, directory, mode };
}
