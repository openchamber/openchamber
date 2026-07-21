import { beforeEach, describe, expect, test } from 'bun:test';
import { useMessageQueueStore } from './messageQueueStore';

describe('message queue transaction context', () => {
  beforeEach(() => {
    useMessageQueueStore.setState({ queuedMessages: {} });
  });

  test('preserves the queued message goal, synthetic, and routing context', () => {
    const syntheticParts = [{ text: 'A-only context', synthetic: true as const }];
    const goalArm = { armed: true, objectiveOverride: 'A objective' };

    useMessageQueueStore.getState().addToQueue('session-a', {
      content: 'message from A',
      syntheticParts,
      goalArm,
      sessionDirectory: '/projects/alpha',
      sessionAgent: null,
      sendConfig: { providerID: 'provider-a', modelID: 'model-a' },
    });

    const [queued] = useMessageQueueStore.getState().getQueueForSession('session-a');
    expect(queued?.syntheticParts).toEqual(syntheticParts);
    expect(queued?.goalArm).toEqual(goalArm);
    expect(queued?.sessionDirectory).toBe('/projects/alpha');
    expect(Object.prototype.hasOwnProperty.call(queued, 'sessionAgent')).toBe(true);
    expect(queued?.sessionAgent).toBeNull();
  });

  test('legacy queued records without transaction context remain usable', () => {
    useMessageQueueStore.setState({
      queuedMessages: {
        'session-a': [{
          id: 'legacy-a',
          content: 'legacy message',
          createdAt: 1,
        }],
      },
    });

    expect(useMessageQueueStore.getState().getQueueForSession('session-a')).toEqual([{
      id: 'legacy-a',
      content: 'legacy message',
      createdAt: 1,
    }]);
  });

  test('keeps transaction context when a queued message is popped for editing', () => {
    const syntheticParts = [{ text: 'A-only context', synthetic: true as const }];
    const goalArm = { armed: true, objectiveOverride: 'A objective' };
    useMessageQueueStore.getState().addToQueue('session-a', {
      content: 'message from A',
      syntheticParts,
      goalArm,
      sessionDirectory: '/projects/alpha',
      sessionAgent: null,
    });
    const queued = useMessageQueueStore.getState().getQueueForSession('session-a')[0];
    expect(queued).toBeDefined();

    const popped = useMessageQueueStore.getState().popToInput('session-a', queued!.id);

    expect(popped?.content).toBe('message from A');
    expect(popped?.syntheticParts).toEqual(syntheticParts);
    expect(popped?.goalArm).toEqual(goalArm);
    expect(popped?.sessionDirectory).toBe('/projects/alpha');
    expect(popped?.sessionAgent).toBeNull();
    expect(useMessageQueueStore.getState().getQueueForSession('session-a')).toEqual([]);
  });
});
