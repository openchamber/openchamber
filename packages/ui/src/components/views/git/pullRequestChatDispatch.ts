import { useSessionUIStore } from '@/sync/session-ui-store';

type PullRequestChatDispatchTarget = {
  sessionId: string;
  directory: string;
  providerID: string;
  modelID: string;
  currentAgentName: string | null;
  currentVariant: string | null;
};

export const sendPullRequestSyntheticPrompt = (
  target: PullRequestChatDispatchTarget,
  visibleText: string,
  instructionsText: string,
  payloadText: string,
): Promise<void> => {
  return useSessionUIStore.getState().sendMessage(
    visibleText,
    target.providerID,
    target.modelID,
    target.currentAgentName ?? undefined,
    undefined,
    undefined,
    [
      { text: instructionsText, synthetic: true },
      { text: payloadText, synthetic: true },
    ],
    target.currentVariant ?? undefined,
    undefined,
    {
      sessionId: target.sessionId,
      sessionDirectory: target.directory,
      sessionAgent: target.currentAgentName,
      // PR actions are synthetic sends, never a composer-goal action. An
      // explicit disarmed state prevents a later-selected composer from losing
      // its own global arm while this dispatch awaits PR work.
      goalArm: { armed: false, objectiveOverride: null },
    },
  );
};
