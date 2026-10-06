import { describe, expect, test } from 'bun:test';

import { getContextObligatoryMessages, withContextObligatoryMessage } from './contextObligatoryMessages';

describe('context obligatory message metadata', () => {
  test('preserves sibling metadata while pinning and unpinning without duplicates', () => {
    const message = { id: 'msg_1', createdAt: 10, role: 'user' as const };
    const initial = { openchamber: { goal: { id: 'goal_1' } }, external: true };
    const pinned = withContextObligatoryMessage(initial, message, true);
    const repinned = withContextObligatoryMessage(pinned, message, true);
    const session = { metadata: repinned } as never;

    expect(getContextObligatoryMessages(session)).toEqual([message]);
    expect((repinned.openchamber as Record<string, unknown>).goal).toEqual({ id: 'goal_1' });
    expect(withContextObligatoryMessage(repinned, message, false)).toEqual({
      external: true,
      openchamber: { goal: { id: 'goal_1' }, context_obligatory_messages: [] },
    });
  });

  test('reads pins in conversation order, not pin order', () => {
    const late = { id: 'msg_3', createdAt: 30, role: 'assistant' as const };
    const early = { id: 'msg_1', createdAt: 10, role: 'user' as const };
    const sameTime = { id: 'msg_2', createdAt: 10, role: 'assistant' as const };
    let metadata = withContextObligatoryMessage({}, late, true);
    metadata = withContextObligatoryMessage(metadata, sameTime, true);
    metadata = withContextObligatoryMessage(metadata, early, true);

    expect(getContextObligatoryMessages({ metadata } as never)).toEqual([early, sameTime, late]);
  });
});
