import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
import { checkIsGitRepository, snapshotGitWorktree } from '@/lib/gitApi';
import { getWorktreeSetupWaitEnabled } from '@/lib/openchamberConfig';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveWorktreeSetupCommands } from '@/lib/sharedTrustConfirmation';
import { waitForWorktreeBootstrap } from '@/lib/worktrees/worktreeBootstrap';
import { resolveCreatedWorktreeStartDirectory } from '@/lib/worktrees/worktreeStartDirectory';
import { createWorktreeWithDefaults } from '@/lib/worktrees/worktreeCreate';
import { dispatchRunPrompt, registerMultiRunSession, toGitSafeSlug, toModelSlug } from '@/stores/useMultiRunStore';
import { requestSessionMetadataUpdate } from '@/sync/session-archive-batch';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { createMultiRunSession } from './createSession';
import { resolveRunMemberLocation, runSnapshotRef } from './keep';
import { loadLaneFirstPrompt } from './laneData';
import { multiRunMembershipPatch, type MultiRunMembership } from './identity';
import { multiRunVariantLabel, readMultiRunIdentity, type MultiRunSummary } from './runs';
import { generateUuid } from '@/lib/uuid';

export async function renameRun(run: MultiRunSummary, title: string, sessionById: ReadonlyMap<string, Session>): Promise<string[]> {
  const nextTitle = title.trim().slice(0, 200);
  if (!nextTitle) return [];
  const failed: string[] = [];
  await Promise.all(run.memberIds.map(async (sessionId) => {
    const session = sessionById.get(sessionId);
    if (!session) {
      failed.push(sessionId);
      return;
    }
    const result = await requestSessionMetadataUpdate(sessionId, { openchamber: { multirun: { title: nextTitle } } }, session.directory);
    if (result.outcome !== 'updated') {
      failed.push(sessionId);
      return;
    }
    registerMultiRunSession({ ...session, metadata: result.metadata }, session.directory);
  }));
  return failed;
}

export async function detachFromRun(session: Session, runTitle: string): Promise<void> {
  const result = await requestSessionMetadataUpdate(session.id, { openchamber: { multirun: null } }, session.directory);
  if (result.outcome !== 'updated') throw new Error(`Multi-run membership was not removed: ${result.reason}`);
  registerMultiRunSession({ ...session, metadata: result.metadata }, session.directory);
  const title = runTitle.trim();
  if (title && title !== session.title) await useSessionUIStore.getState().updateSessionTitle(session.id, title);
}

export async function archiveRun(run: MultiRunSummary): Promise<{ archivedIds: string[]; failedIds: string[] }> {
  return useSessionUIStore.getState().archiveSessions([...run.memberIds]);
}

export class NotFirstTurnError extends Error {
  constructor() {
    super('Only the first answer of a chat can be compared');
    this.name = 'NotFirstTurnError';
  }
}

export async function askOtherModels(input: {
  session: Session;
  turnUserMessageId: string;
  models: ReadonlyArray<{ providerID: string; modelID: string; variant?: string; displayName?: string }>;
}): Promise<{ runKey: string; failedCount: number }> {
  const { session } = input;
  const prompt = await loadLaneFirstPrompt(session.id, session.directory);
  if (!prompt || prompt.messageId !== input.turnUserMessageId) throw new NotFirstTurnError();
  const providerID = session.model?.providerID;
  const modelID = session.model?.id;
  if (!providerID || !modelID) throw new Error('The chat has no model to compare against');

  const title = (session.title || prompt.text.split('\n')[0] || 'Run').trim().slice(0, 200);
  const membership: MultiRunMembership = {
    version: 1,
    sessionID: session.id,
    group: { kind: 'id', id: generateUuid() },
    groupSlug: toGitSafeSlug(title) || 'multi-run',
    providerID,
    modelID,
    role: 'run',
    title,
  };
  const result = await requestSessionMetadataUpdate(session.id, multiRunMembershipPatch(membership), session.directory);
  if (result.outcome !== 'updated') throw new Error(`Multi-run membership was not saved: ${result.reason}`);
  const bound: Session = { ...session, metadata: result.metadata };
  registerMultiRunSession(bound, session.directory);

  const identity = readMultiRunIdentity(bound, session.directory);
  if (!identity) throw new Error('Multi-run membership was not saved');
  const run: MultiRunSummary = {
    key: identity.key,
    title,
    groupSlug: membership.groupSlug,
    lanes: [{ sessionId: session.id, identity }],
    fusions: [],
    memberIds: [session.id],
    providerIDs: [providerID],
    variants: [undefined],
    createdAt: session.time.created,
    lastActivity: session.time.updated,
  };
  const sessionById = new Map([[session.id, bound]]);
  let failedCount = 0;
  for (const model of input.models) {
    try {
      const laneId = await addLaneToRun({ run, runGroup: undefined, model, sessionById, isolateFromProjectRoot: true });
      const created = { sessionId: laneId, identity: { ...identity, providerID: model.providerID, modelID: model.modelID } };
      run.lanes = [...run.lanes, created];
    } catch (error) {
      console.warn('[MultiRun] Could not add a lane', error);
      failedCount += 1;
    }
  }
  return { runKey: identity.key, failedCount };
}

export async function addLaneToRun(input: {
  run: MultiRunSummary;
  runGroup: string | undefined;
  model: { providerID: string; modelID: string; variant?: string; displayName?: string };
  sessionById: ReadonlyMap<string, Session>;
  isolateFromProjectRoot?: boolean;
}): Promise<string> {
  const { run, model } = input;
  const runtimeKey = getRuntimeKey();
  const client = opencodeClient.getSdkClient();
  const assertCurrent = () => {
    if (getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== client) throw new Error('Runtime changed');
  };
  const template = run.lanes.find((lane) => lane.identity.runGroup === input.runGroup) ?? run.lanes[0];
  const templateSession = template ? input.sessionById.get(template.sessionId) : undefined;
  if (!template || !templateSession) throw new Error('Run has no lane to copy');

  const prompt = await loadLaneFirstPrompt(templateSession.id, templateSession.directory);
  assertCurrent();
  if (!prompt?.text) throw new Error('The run prompt could not be read');
  const location = await resolveRunMemberLocation(templateSession, run);
  assertCurrent();

  const sameModel = run.lanes.filter((lane) => lane.identity.runGroup === template.identity.runGroup
    && lane.identity.providerID === model.providerID && lane.identity.modelID === model.modelID);
  const index = sameModel.length > 0 ? sameModel.length + 1 : undefined;
  const variantLabel = run.variants.length > 1 ? multiRunVariantLabel(template.identity.runGroup) : null;

  let directory = templateSession.directory;
  let worktree: Awaited<ReturnType<typeof createWorktreeWithDefaults>> | null = null;
  const startDirectory = location?.worktree?.path
    ?? (input.isolateFromProjectRoot && location && await checkIsGitRepository(location.project.path) ? location.project.path : null);
  assertCurrent();
  if (location && startDirectory) {
    const { head } = await snapshotGitWorktree(startDirectory, { ref: runSnapshotRef(run, templateSession.id) });
    assertCurrent();
    const modelPart = `${toModelSlug(model.providerID, model.modelID)}${index ? `/${index}` : ''}`;
    const preferredName = [template.identity.runGroup, toGitSafeSlug(run.groupSlug) || 'multi-run', modelPart].filter(Boolean).join('/');
    const setupCommands = await resolveWorktreeSetupCommands(location.project);
    assertCurrent();
    worktree = await createWorktreeWithDefaults(location.project, {
      preferredName,
      mode: 'new',
      branchName: preferredName,
      worktreeName: preferredName,
      startRef: head,
      setupCommands,
      returnAfterDirectoryCreated: true,
    });
    assertCurrent();
    if (await getWorktreeSetupWaitEnabled(location.project)) {
      await waitForWorktreeBootstrap(worktree.path);
      assertCurrent();
    }
    directory = await resolveCreatedWorktreeStartDirectory(location.project, worktree);
    assertCurrent();
  }

  const session = await createMultiRunSession({
    title: [`${model.displayName || model.modelID}${index ? ` #${index}` : ''}`, ...(variantLabel ? [variantLabel] : []), run.title].join(' · '),
    directory,
    identity: {
      group: template.identity.group,
      groupSlug: template.identity.groupSlug,
      runGroup: template.identity.runGroup,
      providerID: model.providerID,
      modelID: model.modelID,
      index,
      role: 'run',
      title: run.title,
    },
    selection: { model: { providerID: model.providerID, id: model.modelID, variant: model.variant }, agent: templateSession.agent },
  }, assertCurrent);
  registerMultiRunSession(session, directory);
  if (worktree) useSessionUIStore.getState().setWorktreeMetadata(session.id, { ...worktree, kind: 'standard' }, directory);

  await dispatchRunPrompt({
    runtimeKey,
    assertCurrent,
    sessionId: session.id,
    directory,
    prompt: prompt.text,
    providerID: model.providerID,
    modelID: model.modelID,
    variant: model.variant,
    agent: templateSession.agent,
    files: prompt.files.map((file) => ({ type: 'file' as const, mime: file.mime, url: file.url, filename: file.filename ?? 'attachment' })),
  });
  return session.id;
}
