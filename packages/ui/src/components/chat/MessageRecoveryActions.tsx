import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { useI18n } from '@/lib/i18n';
import { getModelPoolTargets, modelForRecoveryAnchor, nextModelPoolTarget, recoveryUserMessage, MODEL_ROUTE_PROVIDER_ID } from '@/lib/sessionErrorRecovery';
import { useConfigStore, selectProvidersForDirectory } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession, useSessionMessages, useSessionStatus, useSessionStatusSnapshotReady } from '@/sync/sync-context';

interface MessageRecoveryActionsProps {
  sessionId: string;
  directory?: string;
  /** An errored assistant message; omitted for a session-level no-reply notice. */
  anchorMessageId?: string;
}

/** Retry the latest failed prompt, optionally changing models without losing its context. */
export const MessageRecoveryActions: React.FC<MessageRecoveryActionsProps> = ({ sessionId, directory, anchorMessageId }) => {
  const { t } = useI18n();
  const messages = useSessionMessages(sessionId, directory);
  const session = useSession(sessionId, directory);
  const status = useSessionStatus(sessionId, directory);
  const statusSnapshotReady = useSessionStatusSnapshotReady(directory, sessionId);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const savedModel = useSelectionStore((state) => state.sessionModelSelections.get(sessionId) ?? null);
  const providers = useConfigStore((state) => directory === undefined
    ? state.providers
    : selectProvidersForDirectory(state, directory));
  // Selected one field at a time: a selector that builds an object returns a
  // new snapshot on every read, which useSyncExternalStore treats as a change
  // and re-renders until React aborts with "Maximum update depth exceeded".
  const configProviderID = useConfigStore((state) => state.currentProviderId);
  const configModelID = useConfigStore((state) => state.currentModelId);
  const configSelection = React.useMemo(
    () => ({ providerID: configProviderID, id: configModelID }),
    [configProviderID, configModelID],
  );
  const [pending, setPending] = React.useState(false);

  const userMessage = React.useMemo(
    () => recoveryUserMessage(messages, anchorMessageId),
    [anchorMessageId, messages],
  );
  const lastConversationMessage = React.useMemo(
    () => [...messages].reverse().find((message) => message.role === 'user' || message.role === 'assistant'),
    [messages],
  );
  const isLatestFailure = !anchorMessageId || lastConversationMessage?.id === anchorMessageId;
  const isIdle = status?.type === 'idle' || (status === undefined && statusSnapshotReady);

  const selectedModel = React.useMemo(() => {
    if (savedModel?.providerId && savedModel.modelId) {
      return { providerID: savedModel.providerId, id: savedModel.modelId };
    }
    if (session?.model?.providerID && session.model.id) return session.model;
    if (currentSessionId === sessionId && configSelection.providerID && configSelection.id) return configSelection;
    return null;
  }, [configSelection, currentSessionId, savedModel, session, sessionId]);

  const poolTargets = React.useMemo(
    () => selectedModel
      ? getModelPoolTargets(providers, selectedModel.providerID, selectedModel.id)
      : [],
    [providers, selectedModel],
  );
  const isPool = selectedModel?.providerID === MODEL_ROUTE_PROVIDER_ID;
  const failedModel = userMessage
    ? modelForRecoveryAnchor(messages, anchorMessageId, userMessage.id)
    : null;
  const nextTarget = nextModelPoolTarget(poolTargets, failedModel);

  const retry = React.useCallback(async (model: { providerID: string; id: string; variant?: string | null }) => {
    if (pending || !userMessage) return;
    setPending(true);
    try {
      await useSessionUIStore.getState().retryMessage(sessionId, userMessage.id, model);
    } catch (error) {
      console.error('[message-recovery] retry failed:', error);
      toast.error(t('chat.sessionErrorRecovery.failed'));
    } finally {
      setPending(false);
    }
  }, [pending, sessionId, t, userMessage]);

  if (!sessionId || !userMessage || !isLatestFailure || !isIdle) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 ps-[1.375rem]">
      {pending ? (
        <Button type="button" variant="secondary" size="sm" disabled>
          <Icon name="loader-4" className="me-1.5 size-3.5 animate-spin" />
          {t('chat.sessionErrorRecovery.retrying')}
        </Button>
      ) : (
        <ModelSelector
          providerId=""
          modelId=""
          placeholder={t('chat.sessionErrorRecovery.chooseModel')}
          onChange={(providerID, modelID) => {
            if (providerID && modelID) void retry({ providerID, id: modelID });
          }}
          directory={directory}
          className="w-full max-w-64"
        />
      )}
      {isPool ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending || !nextTarget}
          title={nextTarget ? `${nextTarget.providerID}/${nextTarget.id}` : t('chat.sessionErrorRecovery.noNextPoolTarget')}
          onClick={() => { if (nextTarget) void retry(nextTarget); }}
        >
          {t('chat.sessionErrorRecovery.nextPoolTarget')}
        </Button>
      ) : null}
    </div>
  );
};
