import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import { buildSessionMessageRecordsSnapshot } from './sync-context';
import { INITIAL_STATE, type State } from './types';
import {
  addPostRevertBranchReplacement,
  reconcilePostRevertBranchOverlay,
  removePostRevertBranchReplacement,
} from './message-visibility';

const message = (id: string, role: 'user' | 'assistant', parentID?: string): Message => ({
  id,
  role,
  sessionID: 'ses_1',
  ...(parentID ? { parentID } : {}),
  time: { created: 1 },
} as Message);

const textPart = (id: string, text: string): Part => ({
  id,
  type: 'text',
  text,
} as Part);

const state = (partial: Partial<State>): State => ({
  ...INITIAL_STATE,
  ...partial,
});

describe('buildSessionMessageRecordsSnapshot', () => {
  test('keeps an optimistic replacement branch visible without clearing the authoritative marker', () => {
    const beforeRevert = message('msg_001', 'user');
    const reverted = message('msg_002', 'user');
    const discarded = message('msg_003', 'assistant');
    const optimisticReplacement = message('msg_004', 'user');
    const session = { id: 'ses_1', revert: { messageID: 'msg_002' } } as State['session'][number];
    const messages = [beforeRevert, reverted, discarded, optimisticReplacement];
    const previous = buildSessionMessageRecordsSnapshot(
      state({
        session: [session],
        message: { ses_1: messages },
      }),
      'ses_1',
    );

    const next = buildSessionMessageRecordsSnapshot(
      state({
        session: [session],
        message: { ses_1: messages },
        postRevertBranch: addPostRevertBranchReplacement({}, 'ses_1', 'msg_002', 'msg_004'),
      }),
      'ses_1',
      previous,
    );

    expect(previous.list.map((record) => record.info.id)).toEqual(['msg_001']);
    expect(next.list.map((record) => record.info.id)).toEqual(['msg_001', 'msg_004']);
  });

  test('hides a hard-failed replacement while preserving the reverted branch boundary', () => {
    const overlay = addPostRevertBranchReplacement({}, 'ses_1', 'msg_002', 'msg_004');
    const afterHardFailure = removePostRevertBranchReplacement(overlay, 'ses_1', 'msg_004');
    const snapshot = buildSessionMessageRecordsSnapshot(
      state({
        session: [{ id: 'ses_1', revert: { messageID: 'msg_002' } } as State['session'][number]],
        message: {
          ses_1: [
            message('msg_001', 'user'),
            message('msg_002', 'user'),
            message('msg_003', 'assistant'),
          ],
        },
        postRevertBranch: afterHardFailure,
      }),
      'ses_1',
    );

    expect(afterHardFailure).toEqual({});
    expect(snapshot.list.map((record) => record.info.id)).toEqual(['msg_001']);
  });

  test('keeps confirmed replacement and subsequent branch messages visible while the marker matches', () => {
    const overlay = addPostRevertBranchReplacement({}, 'ses_1', 'msg_002', 'msg_004');
    const confirmedOverlay = addPostRevertBranchReplacement(overlay, 'ses_1', 'msg_002', 'msg_006');
    const snapshot = buildSessionMessageRecordsSnapshot(
      state({
        session: [{ id: 'ses_1', revert: { messageID: 'msg_002' } } as State['session'][number]],
        message: {
          ses_1: [
            message('msg_001', 'user'),
            message('msg_002', 'user'),
            message('msg_003', 'assistant'),
            message('msg_004', 'user'),
            message('msg_005', 'assistant'),
            message('msg_006', 'user'),
            message('msg_007', 'assistant'),
          ],
        },
        postRevertBranch: confirmedOverlay,
      }),
      'ses_1',
    );

    expect(snapshot.list.map((record) => record.info.id)).toEqual([
      'msg_001',
      'msg_004',
      'msg_005',
      'msg_006',
      'msg_007',
    ]);
  });

  test('ignores and retires an overlay after the authoritative marker changes or is removed', () => {
    const overlay = addPostRevertBranchReplacement({}, 'ses_1', 'msg_002', 'msg_004');
    const oldSession = { id: 'ses_1', revert: { messageID: 'msg_002' } } as State['session'][number];
    const messages = [
      message('msg_001', 'user'),
      message('msg_002', 'user'),
      message('msg_003', 'assistant'),
      message('msg_004', 'user'),
    ];
    const movedSession = { id: 'ses_1', revert: { messageID: 'msg_003' } } as State['session'][number];

    const moved = buildSessionMessageRecordsSnapshot(
      state({ session: [movedSession], message: { ses_1: messages }, postRevertBranch: overlay }),
      'ses_1',
    );
    const restored = buildSessionMessageRecordsSnapshot(
      state({ session: [{ id: 'ses_1' } as State['session'][number]], message: { ses_1: messages }, postRevertBranch: overlay }),
      'ses_1',
    );

    expect(moved.list.map((record) => record.info.id)).toEqual(['msg_001', 'msg_002']);
    expect(restored.list.map((record) => record.info.id)).toEqual(['msg_001', 'msg_002', 'msg_003', 'msg_004']);
    expect(reconcilePostRevertBranchOverlay(overlay, 'ses_1', oldSession, movedSession)).toEqual({});
    expect(reconcilePostRevertBranchOverlay(overlay, 'ses_1', oldSession, undefined)).toEqual({});
  });

  test('moves the replacement boundary after the first of multiple sends rolls back', () => {
    const first = addPostRevertBranchReplacement({}, 'ses_1', 'msg_002', 'msg_004');
    const second = addPostRevertBranchReplacement(first, 'ses_1', 'msg_002', 'msg_006');
    const afterFirstFailure = removePostRevertBranchReplacement(second, 'ses_1', 'msg_004');
    const snapshot = buildSessionMessageRecordsSnapshot(
      state({
        session: [{ id: 'ses_1', revert: { messageID: 'msg_002' } } as State['session'][number]],
        message: {
          ses_1: [
            message('msg_001', 'user'),
            message('msg_002', 'user'),
            message('msg_003', 'assistant'),
            message('msg_005', 'assistant'),
            message('msg_006', 'user'),
            message('msg_007', 'assistant'),
          ],
        },
        postRevertBranch: afterFirstFailure,
      }),
      'ses_1',
    );

    expect(afterFirstFailure.ses_1?.replacementMessageIDs).toEqual(['msg_006']);
    expect(snapshot.list.map((record) => record.info.id)).toEqual(['msg_001', 'msg_006', 'msg_007']);
  });

  test('only suspends part updates for the active streaming message', () => {
    const user = message('user_1', 'user');
    const assistant1 = message('assistant_1', 'assistant', 'user_1');
    const assistant2 = message('assistant_2', 'assistant', 'user_1');
    const messages = [user, assistant1, assistant2];
    const assistant1InitialParts = [textPart('assistant_1_initial', 'initial')];
    const assistant2InitialParts = [textPart('assistant_2_initial', 'initial')];

    const previous = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: {
          assistant_1: assistant1InitialParts,
          assistant_2: assistant2InitialParts,
        },
      }),
      'ses_1',
      undefined,
      true,
      'assistant_1',
    );

    const assistant1FinalParts = [textPart('assistant_1_final', 'final')];
    const assistant2LiveParts = [textPart('assistant_2_live', 'live')];
    const next = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: {
          assistant_1: assistant1FinalParts,
          assistant_2: assistant2LiveParts,
        },
      }),
      'ses_1',
      previous,
      true,
      'assistant_2',
    );

    expect(next.byId.get('assistant_1')?.parts).toBe(assistant1FinalParts);
    expect(next.byId.get('assistant_2')?.parts).toBe(assistant2InitialParts);
  });
});
