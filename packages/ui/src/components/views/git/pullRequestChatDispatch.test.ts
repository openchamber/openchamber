import { beforeEach, describe, expect, mock, test } from 'bun:test';

let currentSessionId = 'session-a';
let globalGoalArm: { armed: boolean; objectiveOverride: string | null } = {
  armed: true,
  objectiveOverride: 'B objective',
};
const sendMessageCalls: unknown[][] = [];

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      currentSessionId,
      sendMessage: (...args: unknown[]) => {
        const options = args[9] as { goalArm?: typeof globalGoalArm } | undefined;
        if (!options?.goalArm) {
          globalGoalArm = { armed: false, objectiveOverride: null };
        }
        sendMessageCalls.push(args);
        return Promise.resolve();
      },
    }),
  },
}));

import { sendPullRequestSyntheticPrompt } from './pullRequestChatDispatch';

describe('sendPullRequestSyntheticPrompt', () => {
  beforeEach(() => {
    currentSessionId = 'session-a';
    globalGoalArm = { armed: true, objectiveOverride: 'B objective' };
    sendMessageCalls.length = 0;
  });

  test('uses the captured target session after asynchronous work changes the selection', async () => {
    const target = {
      sessionId: currentSessionId,
      directory: '/projects/alpha',
      providerID: 'provider-a',
      modelID: 'model-a',
      currentAgentName: 'agent-a',
      currentVariant: 'variant-a',
    };

    await Promise.resolve();
    currentSessionId = 'session-b';

    await sendPullRequestSyntheticPrompt(target, 'visible prompt', 'instructions', 'payload');

    expect(sendMessageCalls).toEqual([
      [
        'visible prompt',
        'provider-a',
        'model-a',
        'agent-a',
        undefined,
        undefined,
        [
          { text: 'instructions', synthetic: true },
          { text: 'payload', synthetic: true },
        ],
        'variant-a',
        undefined,
        {
          sessionId: 'session-a',
          sessionDirectory: '/projects/alpha',
          sessionAgent: 'agent-a',
          goalArm: { armed: false, objectiveOverride: null },
        },
      ],
    ]);
    expect(globalGoalArm).toEqual({ armed: true, objectiveOverride: 'B objective' });
  });
});
