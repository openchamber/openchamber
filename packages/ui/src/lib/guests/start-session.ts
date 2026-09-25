import { toast } from 'sonner';
import type {
  AttachIssueRequest,
  HostRequestErrorCode,
  PromptRequest,
  PromptResult,
  StartSessionRequest,
  StartSessionResult,
  GuestWorktree,
} from '@openchamber/sdk';
import { HostRequestError, clampPromptRequest, clampStartSessionRequest } from '@openchamber/sdk';

import type { I18nKey, I18nParams } from '@/lib/i18n';
import { generateBranchSlug } from '@/lib/git/branchNameGenerator';
import { buildLinkedGuestIssue, type LinkedGuestIssue } from '@/lib/linkedIssues';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { modelVariantNames } from '@/lib/modelVariants';
import { resolveProjectRef } from '@/lib/worktreeSessionCreator';
import { createWorktreeWithDefaults } from '@/lib/worktrees/worktreeCreate';
import { waitForWorktreeBootstrap } from '@/lib/worktrees/worktreeBootstrap';
import { getWorktreeSetupWaitEnabled } from '@/lib/openchamberConfig';
import { resolveWorktreeSetupCommands } from '@/lib/sharedTrustConfirmation';
import { guestProject, guestProjectWorktrees } from './workspace';
import { normalizePath } from '@/lib/pathNormalization';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { WorktreeMetadata } from '@/types/worktree';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSelectionStore } from '@/sync/selection-store';
import * as sessionActions from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';

type TranslateFn = (key: I18nKey, params?: I18nParams) => string;

type StartGuestSessionPlan =
  | { ok: false; reason: 'no-directory' }
  | {
      ok: true;
      directory: string;
      title: string;
      worktree: boolean;
      branchName: string;
      kind: 'pr' | 'standard';
      linked: LinkedGuestIssue;
      text?: string;
    };

export const guestSessionTitle = (request: StartSessionRequest): string => (
  `${request.id} ${request.title}`.trim()
);

export const guestWorktreeBranch = (id: string, kind: 'issue' | 'pull'): string => {
  const slug = id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${kind === 'pull' ? 'pr' : 'issue'}-${slug || 'guest'}`;
};

export const planStartGuestSession = (
  request: StartSessionRequest,
  directory: string | null,
  now: number,
): StartGuestSessionPlan => {
  const folder = directory?.trim() ?? '';
  if (!folder) {
    return { ok: false, reason: 'no-directory' };
  }
  const clamped = clampStartSessionRequest(request);
  const kind = clamped.kind === 'pull' ? 'pull' : 'issue';
  const next: Extract<StartGuestSessionPlan, { ok: true }> = {
    ok: true,
    directory: folder,
    title: guestSessionTitle(clamped),
    worktree: Boolean(clamped.worktree),
    branchName: guestWorktreeBranch(clamped.id, kind),
    kind: kind === 'pull' ? 'pr' : 'standard',
    linked: buildLinkedGuestIssue({
      providerId: clamped.providerId,
      identifier: clamped.id,
      title: clamped.title,
      url: clamped.url,
      thread: kind,
      author: clamped.author,
      head: clamped.branches?.head,
      base: clamped.branches?.base,
      data: clamped.data,
      linkedAt: now,
    }),
  };
  if (clamped.text) {
    next.text = clamped.text;
  }
  return next;
};

type CreatedSession = {
  id: string;
  directory: string;
};

export type StartGuestSessionDeps = {
  createSession: (title: string, directory: string) => Promise<CreatedSession | null>;
  createWorktree: (
    directory: string,
    branch: string,
    kind: 'pr' | 'standard',
  ) => Promise<CreatedSession | null>;
  initializeSession: (sessionId: string) => void;
  setLinkedIssue: (sessionId: string, directory: string, issue: LinkedGuestIssue) => Promise<void>;
  sendFirstMessage: (sessionId: string, directory: string, text: string) => Promise<'sent' | 'no-model' | 'failed'>;
  closeSurfaces: () => void;
};

type StartGuestSessionRun =
  | { ok: true; sessionId: string; sent: 'sent' | 'no-model' | 'skipped' | 'failed' }
  | { ok: false; reason: 'create-failed' | 'worktree-failed' };

export const runStartGuestSession = async (
  plan: Extract<StartGuestSessionPlan, { ok: true }>,
  deps: StartGuestSessionDeps,
): Promise<StartGuestSessionRun> => {
  const created = plan.worktree
    ? await deps.createWorktree(plan.directory, plan.branchName, plan.kind)
    : await deps.createSession(plan.title, plan.directory);
  if (!created) {
    return { ok: false, reason: plan.worktree ? 'worktree-failed' : 'create-failed' };
  }
  deps.initializeSession(created.id);
  deps.closeSurfaces();
  await deps.setLinkedIssue(created.id, created.directory, plan.linked);
  if (!plan.text) {
    return { ok: true, sessionId: created.id, sent: 'skipped' };
  }
  const sent = await deps.sendFirstMessage(created.id, created.directory, plan.text);
  return { ok: true, sessionId: created.id, sent };
};

const resolveDefaultAgentName = (): string | undefined => {
  const configState = useConfigStore.getState();
  if (configState.settingsDefaultAgent) {
    return configState.settingsDefaultAgent;
  }
  const visibleAgents = configState.agents.filter((agent) => !agent.hidden);
  return (
    configState.currentAgentName
    || visibleAgents.find((agent) => agent.mode === 'primary' || !agent.mode)?.name
    || visibleAgents[0]?.name
  );
};

const resolveDefaultModelSelection = (): { providerID: string; modelID: string } | null => {
  const parsed = parseModelIdentifier(useConfigStore.getState().settingsDefaultModel);
  if (!parsed) {
    return null;
  }
  if (!useConfigStore.getState().getModelMetadata(parsed.providerId, parsed.modelId)) {
    return null;
  }
  return { providerID: parsed.providerId, modelID: parsed.modelId };
};

const resolveDefaultVariant = (providerID: string, modelID: string): string | undefined => {
  const configState = useConfigStore.getState();
  const settingsDefaultVariant = configState.settingsDefaultVariant;
  const currentVariant = configState.currentProviderId === providerID && configState.currentModelId === modelID
    ? configState.currentVariant
    : undefined;
  const provider = configState.providers.find((entry) => entry.id === providerID);
  const model = provider?.models.find((entry) => entry.id === modelID);
  const variantNames = modelVariantNames(model);
  if (variantNames.length === 0) {
    return settingsDefaultVariant || currentVariant || undefined;
  }
  if (settingsDefaultVariant && variantNames.includes(settingsDefaultVariant)) {
    return settingsDefaultVariant;
  }
  if (currentVariant && variantNames.includes(currentVariant)) {
    return currentVariant;
  }
  return undefined;
};

const captureGuestSendSelection = () => {
  const configState = useConfigStore.getState();
  const lastUsedProvider = useSelectionStore.getState().lastUsedProvider;
  const defaultModel = resolveDefaultModelSelection();
  const providerID = defaultModel?.providerID || configState.currentProviderId || lastUsedProvider?.providerID;
  const modelID = defaultModel?.modelID || configState.currentModelId || lastUsedProvider?.modelID;
  const agentName = resolveDefaultAgentName() || configState.currentAgentName || undefined;
  if (!providerID || !modelID) {
    return null;
  }
  return { providerID, modelID, agentName, variant: resolveDefaultVariant(providerID, modelID) };
};

const sendGuestFirstMessage = async (
  sessionId: string,
  directory: string,
  text: string,
  selection = captureGuestSendSelection(),
): Promise<'sent' | 'no-model' | 'failed'> => {
  if (!selection) return 'no-model';
  try {
    await useSessionUIStore.getState().sendMessage(
      text,
      selection.providerID,
      selection.modelID,
      selection.agentName,
      undefined,
      undefined,
      undefined,
      selection.variant,
      undefined,
      { sessionId, directory },
    );
    return 'sent';
  } catch {
    return 'failed';
  }
};

type GuestActionFailure = {
  ok: false;
  code: HostRequestErrorCode;
  message: string;
};

type LinkGuestPlan =
  | { ok: false; code: HostRequestErrorCode; message: string; toastKey: I18nKey }
  | { ok: true; sessionId: string; directory: string; linked: LinkedGuestIssue };

export const planLinkGuestSession = (
  request: AttachIssueRequest,
  sessionId: string | null,
  directory: string | null,
  now: number,
): LinkGuestPlan => {
  const folder = directory?.trim() ?? '';
  if (!folder) {
    return {
      ok: false,
      code: 'HOST_REJECTED',
      message: 'Open a project first.',
      toastKey: 'contextPanel.plugin.startSession.noProject',
    };
  }
  const id = sessionId?.trim() ?? '';
  if (!id) {
    return {
      ok: false,
      code: 'NO_SESSION',
      message: 'No open session.',
      toastKey: 'contextPanel.plugin.sessionLink.noSession',
    };
  }
  const plan = planStartGuestSession(request, folder, now);
  if (!plan.ok) {
    return {
      ok: false,
      code: 'HOST_REJECTED',
      message: 'Open a project first.',
      toastKey: 'contextPanel.plugin.startSession.noProject',
    };
  }
  return { ok: true, sessionId: id, directory: folder, linked: plan.linked };
};

export const linkGuestSession = async (args: {
  request: AttachIssueRequest;
  sessionId: string | null;
  directory: string | null;
  t: TranslateFn;
}): Promise<{ ok: true } | GuestActionFailure> => {
  const plan = planLinkGuestSession(args.request, args.sessionId, args.directory, Date.now());
  if (!plan.ok) {
    toast.error(args.t(plan.toastKey));
    return { ok: false, code: plan.code, message: plan.message };
  }
  try {
    await sessionActions.setLinkedIssue(plan.sessionId, plan.directory, plan.linked, true);
    toast.success(args.t('contextPanel.plugin.sessionLink.linked'));
    return { ok: true };
  } catch {
    toast.error(args.t('contextPanel.plugin.sessionLink.failed'));
    return { ok: false, code: 'HOST_REJECTED', message: 'Could not link that item.' };
  }
};

type PromptGuestPlan =
  | { ok: false; code: HostRequestErrorCode; message: string; toastKey: I18nKey }
  | { ok: true; action: 'compose'; text: string }
  | { ok: true; action: 'send'; text: string; sessionId: string; directory: string };

export const planPromptGuestSession = (args: {
  request: PromptRequest;
  sessionId: string | null;
  directory: string | null;
  busy: boolean;
}): PromptGuestPlan => {
  const clamped = clampPromptRequest(args.request);
  const sessionId = args.sessionId?.trim() ?? '';
  if (!sessionId) {
    return {
      ok: false,
      code: 'NO_SESSION',
      message: 'No open session.',
      toastKey: 'contextPanel.plugin.prompt.noSession',
    };
  }
  if (!clamped.send) {
    return { ok: true, action: 'compose', text: clamped.text };
  }
  if (args.busy) {
    return {
      ok: false,
      code: 'SESSION_BUSY',
      message: 'Session is busy.',
      toastKey: 'contextPanel.plugin.prompt.busy',
    };
  }
  const folder = args.directory?.trim() ?? '';
  if (!folder) {
    return {
      ok: false,
      code: 'HOST_REJECTED',
      message: 'Open a project first.',
      toastKey: 'contextPanel.plugin.startSession.noProject',
    };
  }
  return { ok: true, action: 'send', text: clamped.text, sessionId, directory: folder };
};

export const promptGuestSession = async (args: {
  request: PromptRequest;
  sessionId: string | null;
  directory: string | null;
  busy: boolean;
  compose: (text: string, mode: 'replace' | 'append') => void;
  t: TranslateFn;
}): Promise<{ ok: true; result: PromptResult } | GuestActionFailure> => {
  const plan = planPromptGuestSession(args);
  if (!plan.ok) {
    toast.error(args.t(plan.toastKey));
    return { ok: false, code: plan.code, message: plan.message };
  }
  if (plan.action === 'compose') {
    args.compose(plan.text, 'replace');
    return { ok: true, result: { sent: 'skipped' } };
  }
  const sent = await sendGuestFirstMessage(plan.sessionId, plan.directory, plan.text);
  if (sent === 'no-model') {
    toast.error(args.t('contextPanel.plugin.prompt.noModel'));
  } else if (sent === 'failed') {
    toast.error(args.t('contextPanel.plugin.prompt.sendFailed'));
  }
  return { ok: true, result: { sent } };
};

export const startGuestSession = async (args: {
  request: StartSessionRequest;
  directory: string | null;
  t: TranslateFn;
  assertAuthorized: () => void;
}): Promise<StartSessionResult | null> => {
  args.assertAuthorized();
  const project = args.request.projectId ? guestProject(args.request.projectId) : args.directory ? resolveProjectRef(args.directory) : null;
  const target = args.request.worktree;
  let directory = args.request.projectId ? project?.path ?? null : args.directory;
  let metadata: WorktreeMetadata | undefined;
  if (target && target !== true && target.kind === 'existing') {
    if (!project) throw new HostRequestError('NO_DIRECTORY', 'Project is not registered.');
    metadata = guestProjectWorktrees(project.path).find((entry) => normalizePath(entry.path) === normalizePath(target.directory));
    if (!metadata) throw new HostRequestError('NOT_FOUND', 'Worktree does not belong to this project or has not loaded yet.');
    if (metadata.worktreeStatus === 'missing' || metadata.worktreeStatus === 'invalid' || metadata.worktreeStatus === 'not-a-repo') throw new HostRequestError('HOST_REJECTED', 'Worktree is unavailable.');
    directory = metadata.path;
  }
  const createNew = target === true || Boolean(target && target.kind === 'new');
  const plan = planStartGuestSession({ ...args.request, worktree: createNew }, directory, Date.now());
  if (!plan.ok) {
    toast.error(args.t('contextPanel.plugin.startSession.noProject'));
    return null;
  }

  const navigation = args.request.navigation ?? 'preserve';
  const sendSelection = captureGuestSendSelection();
  let cancelled = false;
  const unsubscribe = subscribeRuntimeEndpointChanged(() => { cancelled = true; });
  const assertCurrent = () => {
    if (cancelled) throw new HostRequestError('DISCONNECTED', 'The connected server changed.');
    args.assertAuthorized();
  };
  let failure: 'bootstrap-failed' | 'session-create-failed' = 'session-create-failed';
  let linked = true;
  let createdDirectory = directory ?? '';
  const worktreeResult = (): GuestWorktree | undefined => {
    if (!metadata) return undefined;
    const latest = project ? guestProjectWorktrees(project.path).find((entry) => entry.path === metadata?.path) ?? metadata : metadata;
    return { directory: latest.path, name: latest.name ?? latest.label, branch: latest.branch,
      status: latest.worktreeStatus === 'not-a-repo' ? 'invalid' : latest.worktreeStatus ?? 'ready' };
  };
  const createTargetSession = async (title: string, directory: string): Promise<CreatedSession | null> => {
    if (metadata && project) {
      failure = 'bootstrap-failed';
      const wait = await getWorktreeSetupWaitEnabled(project);
      assertCurrent();
      if (wait) await waitForWorktreeBootstrap(metadata.path);
    }
    assertCurrent();
    failure = 'session-create-failed';
    // v2 creates the session on a selection, so the first prompt runs on the
    // model the extension asked for without a switch message in the transcript.
    const session = await sessionActions.createSession(
      title,
      directory,
      undefined,
      undefined,
      sendSelection
        ? {
            model: { providerID: sendSelection.providerID, id: sendSelection.modelID, variant: sendSelection.variant },
            agent: sendSelection.agentName,
          }
        : undefined,
      navigation,
    );
    assertCurrent();
    if (!session) return null;
    createdDirectory = session.directory ?? directory;
    if (metadata) {
      const latest = project ? guestProjectWorktrees(project.path).find((entry) => entry.path === metadata?.path) : undefined;
      metadata = { ...metadata, worktreeStatus: latest?.worktreeStatus ?? metadata.worktreeStatus };
      useSessionUIStore.getState().setWorktreeMetadata(session.id, metadata);
    }
    return { id: session.id, directory: createdDirectory };
  };
  try {
    const result = await runStartGuestSession(plan, {
      createSession: createTargetSession,
      createWorktree: async (_directory, branch, kind) => {
        if (!project) throw new HostRequestError('NO_DIRECTORY', 'Project is not registered.');
        const custom = target && target !== true && target.kind === 'new' ? target : undefined;
        const name = custom?.name ?? `${branch}-${generateBranchSlug()}`;
        const setupCommands = await resolveWorktreeSetupCommands(project);
        assertCurrent();
        metadata = await createWorktreeWithDefaults(project, {
          preferredName: name, mode: 'new', branchName: name, worktreeName: name,
          startRef: custom?.baseBranch, setupCommands, returnAfterDirectoryCreated: true,
        });
        assertCurrent();
        metadata = { ...metadata, kind, createdFromBranch: custom?.baseBranch };
        return createTargetSession(plan.title, metadata.path);
      },
      initializeSession: (sessionId) => {
        useSessionUIStore.getState().initializeNewOpenChamberSession(sessionId, useConfigStore.getState().agents);
      },
      setLinkedIssue: async (sessionId, directory, issue) => {
        assertCurrent();
        await sessionActions.setLinkedIssue(sessionId, directory, issue, true).catch(() => { linked = false; });
        assertCurrent();
      },
      sendFirstMessage: (sessionId, directory, text) => {
        assertCurrent();
        return sendGuestFirstMessage(sessionId, directory, text, sendSelection);
      },
      closeSurfaces: () => {
        if (navigation === 'open') useUIStore.getState().closeMainSurfaces();
      },
    });

    assertCurrent();
    if (!result.ok) {
      const worktree = worktreeResult();
      if (worktree) return { sessionId: null, sent: 'skipped', directory: worktree.directory, worktree, failure };
      toast.error(args.t('contextPanel.plugin.startSession.failed'));
      return null;
    }
    if (result.sent === 'no-model') toast.error(args.t('contextPanel.plugin.startSession.noModel'));
    else if (result.sent === 'failed') toast.error(args.t('contextPanel.plugin.startSession.sendFailed'));
    else toast.success(args.t('contextPanel.plugin.startSession.created'));
    return { sessionId: result.sessionId, sent: result.sent, directory: createdDirectory, worktree: worktreeResult(), linked };
  } catch (error) {
    assertCurrent();
    const worktree = worktreeResult();
    if (worktree) return { sessionId: null, sent: 'skipped', directory: worktree.directory, worktree, failure };
    throw error;
  } finally {
    unsubscribe();
  }
};
