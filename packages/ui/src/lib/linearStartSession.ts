import { toast } from '@/components/ui';
import type { LinearAPI, LinearIssue, LinearIssueComment, LinearMappingResult } from '@/lib/api/types';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { modelVariantNames } from '@/lib/modelVariants';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { createWorktreeSessionForNewBranch } from '@/lib/worktreeSessionCreator';
import { generateBranchSlug } from '@/lib/git/branchNameGenerator';
import { buildLinkedLinearIssue } from '@/lib/linkedIssues';
import { resolveLinearMappedProjectPath } from '@/lib/linearProjectMapping';
import { postLinearSessionStarted } from '@/lib/linearSessionStatus';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import * as sessionActions from '@/sync/session-actions';

type TranslateFn = (key: I18nKey, params?: I18nParams) => string;

export function buildIssueContextText(args: {
  issue: LinearIssue;
  comments: LinearIssueComment[];
}): string {
  const payload = {
    issue: args.issue,
    comments: args.comments,
  };
  return `Linear issue context (JSON)\n${JSON.stringify(payload, null, 2)}`;
}

function resolveDefaultAgentName(): string | undefined {
  const configState = useConfigStore.getState();
  const settingsDefaultAgent = configState.settingsDefaultAgent;
  if (settingsDefaultAgent) {
    return settingsDefaultAgent;
  }
  const visibleAgents = configState.agents.filter((agent) => !agent.hidden);
  return (
    configState.currentAgentName
    || visibleAgents.find((agent) => agent.mode === 'primary' || !agent.mode)?.name
    || visibleAgents[0]?.name
  );
}

function resolveDefaultModelSelection(): { providerID: string; modelID: string } | null {
  const configState = useConfigStore.getState();
  const settingsDefaultModel = configState.settingsDefaultModel;
  if (!settingsDefaultModel) {
    return null;
  }

  const parsed = parseModelIdentifier(settingsDefaultModel);
  if (!parsed) {
    return null;
  }
  const { providerId: providerID, modelId: modelID } = parsed;

  const modelMetadata = configState.getModelMetadata(providerID, modelID);
  if (!modelMetadata) {
    return null;
  }

  return { providerID, modelID };
}

function resolveDefaultVariant(providerID: string, modelID: string): string | undefined {
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
}

export async function startLinearIssueSession(args: {
  linear: LinearAPI | undefined;
  issueKey: string;
  createInWorktree: boolean;
  mapping?: LinearMappingResult | null;
  onMappingLoaded?: (mapping: LinearMappingResult) => void;
  onSessionCreated?: () => void;
  t: TranslateFn;
}): Promise<boolean> {
  const { linear, issueKey, createInWorktree, t } = args;
  if (!linear?.issueGet || !linear.mappingGet) {
    toast.error(t('session.linearIssuePicker.error.runtimeUnavailable'));
    return false;
  }

  try {
    let mappingView = args.mapping;
    if (!mappingView) {
      mappingView = await linear.mappingGet();
      args.onMappingLoaded?.(mappingView);
    }
    if (mappingView.connected === false) {
      toast.error(t('session.linearIssuePicker.error.notConnected'));
      return false;
    }

    const issueRes = await linear.issueGet(issueKey);
    if (issueRes.connected === false) {
      toast.error(t('session.linearIssuePicker.error.notConnected'));
      return false;
    }
    const issue = issueRes.issue;
    if (!issue) {
      toast.error(t('session.linearIssuePicker.error.issueNotFound'));
      return false;
    }

    const projectDirectory = resolveLinearMappedProjectPath(mappingView, issue.team);
    if (!projectDirectory) {
      toast.error(t('session.linearIssuePicker.error.noMappedProject'));
      return false;
    }

    const comments = issue.comments ?? [];
    const sessionTitle = `${issue.identifier} ${issue.title}`.trim();
    const login = issue.assignee?.displayName || issue.assignee?.name;

    const { sessionId, sessionDirectory } = await (async () => {
      if (createInWorktree) {
        const preferred = `issue-${issue.identifier}-${generateBranchSlug()}`;
        const created = await createWorktreeSessionForNewBranch(
          projectDirectory,
          preferred,
          undefined,
          { returnAfterDirectoryCreated: true },
        );
        if (!created?.id) {
          throw new Error('Failed to create worktree session');
        }
        return { sessionId: created.id, sessionDirectory: created.path };
      }

      const session = await sessionActions.createSession(sessionTitle, projectDirectory, null);
      if (!session?.id) {
        throw new Error('Failed to create session');
      }
      return { sessionId: session.id, sessionDirectory: session.directory ?? projectDirectory };
    })();

    void sessionActions.updateSessionTitle(sessionId, sessionTitle).catch(() => undefined);

    try {
      useSessionUIStore.getState().initializeNewOpenChamberSession(sessionId, useConfigStore.getState().agents);
    } catch {
      // ignore
    }

    args.onSessionCreated?.();
    useUIStore.getState().closeMainSurfaces();
    useUIStore.getState().setSessionSwitcherOpen(false);

    postLinearSessionStarted(linear, {
      sessionId,
      issueIdentifier: issue.identifier,
    });

    const configState = useConfigStore.getState();
    const lastUsedProvider = useSelectionStore.getState().lastUsedProvider;
    const defaultModel = resolveDefaultModelSelection();
    const providerID = defaultModel?.providerID || configState.currentProviderId || lastUsedProvider?.providerID;
    const modelID = defaultModel?.modelID || configState.currentModelId || lastUsedProvider?.modelID;
    const agentName = resolveDefaultAgentName() || configState.currentAgentName || undefined;
    if (!providerID || !modelID) {
      toast.error(t('session.linearIssuePicker.error.noModelSelected'));
      return true;
    }

    const variant = resolveDefaultVariant(providerID, modelID);
    const visiblePromptText = await renderMagicPrompt('linear.issue.review.visible', {
      identifier: issue.identifier,
    });
    const instructionsText = await renderMagicPrompt('linear.issue.review.instructions');
    const contextText = buildIssueContextText({ issue, comments });

    void sessionActions.setLinkedIssue(
      sessionId,
      sessionDirectory,
      buildLinkedLinearIssue({
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        author: login
          ? { login, avatarUrl: issue.assignee?.avatarUrl || undefined }
          : undefined,
        linkedAt: Date.now(),
      }),
      true,
    ).catch(() => undefined);

    void useSessionUIStore.getState().sendMessage(
      visiblePromptText,
      providerID,
      modelID,
      agentName,
      undefined,
      undefined,
      [
        { text: instructionsText, synthetic: true },
        { text: contextText, synthetic: true },
      ],
      variant,
      undefined,
      { sessionId, directory: sessionDirectory },
    ).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('session.linearIssuePicker.toast.sendContextFailed'), {
        description: message,
      });
    });

    toast.success(t('session.linearIssuePicker.toast.sessionCreated'));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast.error(t('session.linearIssuePicker.toast.startSessionFailed'), { description: message });
    return false;
  }
}
