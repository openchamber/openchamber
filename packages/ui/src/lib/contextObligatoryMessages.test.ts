import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';

import { getContextObligatoryMessages, withContextObligatoryMessage, type ContextObligatoryMessage } from './contextObligatoryMessages';

const pin = (id: string, createdAt: number, sessionID?: string): ContextObligatoryMessage => ({
  id, createdAt, role: 'user', ...(sessionID ? { sessionID } : {}),
});

const sessionWith = (id: string, created: number | undefined, pins: ContextObligatoryMessage[], parentID?: string) => ({
  id,
  parentID,
  time: { created, updated: created },
  metadata: { openchamber: { context_obligatory_messages: pins } },
}) as unknown as Session;

describe('context obligatory message metadata', () => {
  test('preserves sibling metadata while pinning and unpinning without duplicates', () => {
    const message = { id: 'msg_1', createdAt: 10, role: 'user' as const };
    const initial = { openchamber: { goal: { id: 'goal_1' } }, external: true };
    const pinned = withContextObligatoryMessage(initial, message, true, 'ses_top');
    const repinned = withContextObligatoryMessage(pinned, message, true, 'ses_top');
    const session = { ...sessionWith('ses_top', 1, []), metadata: repinned } as never;

    expect(getContextObligatoryMessages(session)).toEqual([{ ...message, sessionID: 'ses_top' }]);
    expect((repinned.openchamber as Record<string, unknown>).goal).toEqual({ id: 'goal_1' });
    expect(withContextObligatoryMessage(repinned, message, false, 'ses_top')).toEqual({
      external: true,
      openchamber: { goal: { id: 'goal_1' }, context_obligatory_messages: [] },
    });
  });

  test('reads pins in conversation order, not pin order', () => {
    const late = { id: 'msg_3', createdAt: 30, role: 'assistant' as const };
    const early = { id: 'msg_1', createdAt: 10, role: 'user' as const };
    const sameTime = { id: 'msg_2', createdAt: 10, role: 'assistant' as const };
    let metadata = withContextObligatoryMessage({}, late, true, 'ses_top');
    metadata = withContextObligatoryMessage(metadata, sameTime, true, 'ses_top');
    metadata = withContextObligatoryMessage(metadata, early, true, 'ses_top');

    expect(getContextObligatoryMessages({ ...sessionWith('ses_top', undefined, []), metadata } as never))
      .toEqual([early, sameTime, late].map((entry) => ({ ...entry, sessionID: 'ses_top' })));
  });

  test('stamps new pins with their owning session and refuses ownerless writes', () => {
    const metadata = withContextObligatoryMessage({}, pin('msg_child', 110), true, 'ses_child');
    expect(getContextObligatoryMessages(sessionWith('ses_child', 100, []))).toEqual([]);
    expect(metadata).toEqual({
      openchamber: {
        context_obligatory_messages: [{ id: 'msg_child', createdAt: 110, role: 'user', sessionID: 'ses_child' }],
      },
    });
    expect(() => withContextObligatoryMessage({}, pin('msg_ownerless', 110), true, '')).toThrow('sessionID is required');
  });

  test('a child shows only its own pins, not pins inherited from its parent', () => {
    const parentA = pin('msg_parent_a', 10, 'ses_parent');
    const childB = pin('msg_child_b', 110, 'ses_child');
    const child = sessionWith('ses_child', 100, [parentA, childB], 'ses_parent');

    expect(getContextObligatoryMessages(child)).toEqual([childB]);
  });

  test('siblings never show each other\'s pins or their parent\'s pins', () => {
    const parentA = pin('msg_parent_a', 10);
    const siblingC = pin('msg_sibling_c', 110);
    const siblingD = pin('msg_sibling_d', 210);
    const first = sessionWith('ses_sibling_1', 100, [parentA, siblingC], 'ses_parent');
    const second = sessionWith('ses_sibling_2', 200, [parentA, siblingC, siblingD], 'ses_parent');

    expect(getContextObligatoryMessages(first)).toEqual([siblingC]);
    expect(getContextObligatoryMessages(second)).toEqual([siblingD]);
  });

  test('depth-two and depth-three sessions drop inherited ancestor pins and same-ms boundaries', () => {
    const parentA = pin('msg_parent_a', 10);
    const childB = pin('msg_child_b', 110);
    const grandchildE = pin('msg_grandchild_e', 310);
    const grandchild = sessionWith('ses_grandchild', 300, [parentA, childB, grandchildE], 'ses_child');
    const depth3 = sessionWith('ses_depth_3', 400, [parentA, childB, grandchildE, pin('msg_depth_3', 410)], 'ses_grandchild');
    const sameMillisecond = sessionWith('ses_same_ms', 100, [pin('msg_same_ms', 100), pin('msg_own', 101)], 'ses_parent');

    expect(getContextObligatoryMessages(grandchild)).toEqual([grandchildE]);
    expect(getContextObligatoryMessages(depth3).map((entry) => entry.id)).toEqual(['msg_depth_3']);
    expect(getContextObligatoryMessages(sameMillisecond).map((entry) => entry.id)).toEqual(['msg_own']);
  });

  test('an explicit foreign owner or an incomplete child session fails closed', () => {
    const foreign = pin('msg_foreign', 110, 'ses_sibling');
    expect(getContextObligatoryMessages(sessionWith('ses_child', 100, [foreign], 'ses_parent'))).toEqual([]);
    expect(getContextObligatoryMessages(sessionWith('ses_child', undefined, [pin('msg_legacy', 110)], 'ses_parent'))).toEqual([]);
    expect(getContextObligatoryMessages({ metadata: { openchamber: { context_obligatory_messages: [pin('msg_legacy', 110)] } } } as never)).toEqual([]);
  });

  test('a legacy own pin remains listed when its message is genuinely gone', () => {
    const missingOwn = pin('msg_missing_own', 110);
    expect(getContextObligatoryMessages(sessionWith('ses_child', 100, [missingOwn], 'ses_parent'))).toEqual([missingOwn]);
  });

  test('a user fork keeps inherited legacy and explicitly owned pins', () => {
    const inherited = [pin('msg_legacy', 10), pin('msg_owned', 20, 'ses_source')];
    expect(getContextObligatoryMessages(sessionWith('ses_fork', 100, inherited))).toEqual(inherited);
    expect(getContextObligatoryMessages(sessionWith('ses_fork', undefined, inherited))).toEqual(inherited);
  });
});
