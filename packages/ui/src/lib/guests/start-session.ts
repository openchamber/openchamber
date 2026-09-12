import { toast } from 'sonner';
import type {
  AttachIssueRequest,
  HostRequestErrorCode,
  PromptRequest,
  PromptResult,
  StartSessionRequest,
  StartSessionResult,
} from '@openchamber/sdk';
import { clampPromptRequest, clampStartSessionRequest } from '@openchamber/sdk';

import type { I18nKey, I18nParams } from '@/lib/i18n';
import { generateBranchSlug } from '@/lib/git/branchNameGenerator';
import { buildLinkedGuestIssue, type LinkedGuestIssue } from '@/lib/linkedIssues';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { modelVariantNames } from '@/lib/modelVariants';
import { createWorktreeSessionForNewBranch } from '@/lib/worktreeSessionCreator';
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

const sendGuestFirstMessage = async (
  sessionId: string,
  directory: string,
  text: string,
): Promise<'sent' | 'no-model' | 'failed'> => {
  const configState = useConfigStore.getState();
  const lastUsedProvider = useSelectionStore.getState().lastUsedProvider;
  const defaultModel = resolveDefaultModelSelection();
  const providerID = defaultModel?.providerID || configState.currentProviderId || lastUsedProvider?.providerID;
  const modelID = defaultModel?.modelID || configState.currentModelId || lastUsedProvider?.modelID;
  const agentName = resolveDefaultAgentName() || configState.currentAgentName || undefined;
  if (!providerID || !modelID) {
    return 'no-model';
  }
  try {
    await useSessionUIStore.getState().sendMessage(
      text,
      providerID,
      modelID,
      agentName,
      undefined,
      undefined,
      undefined,
      resolveDefaultVariant(providerID, modelID),
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
}): Promise<StartSessionResult | null> => {
  const plan = planStartGuestSession(args.request, args.directory, Date.now());
  if (!plan.ok) {
    toast.error(args.t('contextPanel.plugin.startSession.noProject'));
    return null;
  }

  const result = await runStartGuestSession(plan, {
    createSession: async (title, directory) => {
      const session = await sessionActions.createSession(title, directory, null);
      if (!session?.id) {
        return null;
      }
      return { id: session.id, directory: session.directory ?? directory };
    },
    createWorktree: async (directory, branch, kind) => {
      const created = await createWorktreeSessionForNewBranch(
        directory,
        `${branch}-${generateBranchSlug()}`,
        undefined,
        { kind, returnAfterDirectoryCreated: true },
      );
      if (!created?.id) {
        return null;
      }
      return { id: created.id, directory: created.path };
    },
    initializeSession: (sessionId) => {
      void sessionActions.updateSessionTitle(sessionId, plan.title).catch(() => undefined);
      try {
        useSessionUIStore.getState().initializeNewOpenChamberSession(sessionId, useConfigStore.getState().agents);
      } catch {
        // ignore
      }
    },
    setLinkedIssue: async (sessionId, directory, issue) => {
      await sessionActions.setLinkedIssue(sessionId, directory, issue, true).catch(() => undefined);
    },
    sendFirstMessage: sendGuestFirstMessage,
    closeSurfaces: () => {
      useUIStore.getState().closeMainSurfaces();
    },
  });

  if (!result.ok) {
    toast.error(args.t('contextPanel.plugin.startSession.failed'));
    return null;
  }
  if (result.sent === 'no-model') {
    toast.error(args.t('contextPanel.plugin.startSession.noModel'));
  } else if (result.sent === 'failed') {
    toast.error(args.t('contextPanel.plugin.startSession.sendFailed'));
  } else {
    toast.success(args.t('contextPanel.plugin.startSession.created'));
  }
  return { sessionId: result.sessionId, sent: result.sent };
};
