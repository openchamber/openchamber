import { beforeEach, describe, expect, test } from 'bun:test';
import { useInputStore } from '@/sync/input-store';
import { useInlineCommentDraftStore, type InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import {
  captureQueuedMessageEditContext,
  getQueuedMessageEditContextForSession,
  captureComposerSubmitTarget,
  isCurrentComposerSubmitTarget,
  mergeRecoveredAttachments,
  resolveSubmitGoalArm,
  restoreCapturedInlineCommentDrafts,
  shouldClaimComposerGoal,
  shouldRestoreComposerText,
} from './chatSubmitIsolation';

describe('chat submit isolation', () => {
  beforeEach(() => {
    useInputStore.getState().setAttachedFiles([]);
    useInlineCommentDraftStore.setState({ drafts: {} });
  });

  test('failure recovery cannot overwrite a newer session B composer', () => {
    const target = captureComposerSubmitTarget('session-a', null);
    const current = {
      currentSessionId: 'session-b',
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
    };
    const bAttachment = {
      id: 'b-file',
      file: new File(['B'], 'b.txt', { type: 'text/plain' }),
      dataUrl: 'data:text/plain;base64,Qg==',
      mimeType: 'text/plain',
      filename: 'b.txt',
      size: 1,
      source: 'local' as const,
    };
    const recoveredAttachment = {
      id: 'a-file',
      file: new File(['A'], 'a.txt', { type: 'text/plain' }),
      dataUrl: 'data:text/plain;base64,QQ==',
      mimeType: 'text/plain',
      filename: 'a.txt',
      size: 1,
      source: 'local' as const,
    };

    useInputStore.getState().setAttachedFiles([bAttachment]);
    if (shouldRestoreComposerText(target, current, 'B draft', 'A draft')) {
      useInputStore.getState().setAttachedFiles(
        mergeRecoveredAttachments([recoveredAttachment], useInputStore.getState().attachedFiles),
      );
    }

    expect(isCurrentComposerSubmitTarget(target, current)).toBe(false);
    expect(shouldRestoreComposerText(target, current, 'B draft', 'A draft')).toBe(false);
    expect(useInputStore.getState().attachedFiles).toEqual([bAttachment]);
  });

  test('draft tokens distinguish a newer draft B from a captured draft A', () => {
    const draftA = {
      open: true,
      draftToken: Symbol('draft-a'),
      directoryOverride: '/a',
      parentID: null,
    };
    const draftB = {
      open: true,
      draftToken: Symbol('draft-b'),
      directoryOverride: '/b',
      parentID: null,
    };

    expect(isCurrentComposerSubmitTarget(
      captureComposerSubmitTarget(null, draftA),
      { currentSessionId: null, newSessionDraft: draftB },
    )).toBe(false);
  });

  test('restores failed A inline drafts without touching selected session B', () => {
    const draftA: InlineCommentDraft = {
      id: 'draft-a',
      sessionKey: 'session-a',
      source: 'diff',
      fileLabel: 'a.ts',
      startLine: 1,
      endLine: 1,
      code: 'const a = true;',
      language: 'typescript',
      text: 'Review A',
      createdAt: 1,
    };
    const draftB: InlineCommentDraft = {
      ...draftA,
      id: 'draft-b',
      sessionKey: 'session-b',
      text: 'Review B',
    };
    const target = captureComposerSubmitTarget('session-a', null);
    const selectedB = {
      currentSessionId: 'session-b',
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
    };

    useInlineCommentDraftStore.setState({ drafts: { 'session-b': [draftB] } });
    expect(isCurrentComposerSubmitTarget(target, selectedB)).toBe(false);

    restoreCapturedInlineCommentDrafts(
      'session-a',
      [draftA],
      useInlineCommentDraftStore.getState().restoreDrafts,
    );

    expect(useInlineCommentDraftStore.getState().getDrafts('session-a')).toEqual([draftA]);
    expect(useInlineCommentDraftStore.getState().getDrafts('session-b')).toEqual([draftB]);
  });

  test('keeps a popped queued message context scoped to its source session', () => {
    const syntheticParts = [{ text: 'A-only context', synthetic: true as const }];
    const goalArm = { armed: true, objectiveOverride: 'A objective' };
    const context = captureQueuedMessageEditContext('session-a', { syntheticParts, goalArm });

    expect(getQueuedMessageEditContextForSession(context, 'session-a')).toEqual({
      sessionId: 'session-a',
      syntheticParts,
      goalArm,
    });
    expect(getQueuedMessageEditContextForSession(context, 'session-b')).toBeNull();
  });

  test('does not claim a goal arm for local non-send slash commands', () => {
    const base = {
      inputMode: 'normal' as const,
      hasExistingSession: true,
      hasQueuedPrimary: false,
      isMobile: false,
      isVSCode: false,
    };

    expect(shouldClaimComposerGoal({ ...base, content: '/undo' })).toBe(false);
    expect(shouldClaimComposerGoal({ ...base, content: '/compact' })).toBe(false);
    expect(shouldClaimComposerGoal({ ...base, content: '/handoff-review' })).toBe(false);
    expect(shouldClaimComposerGoal({ ...base, isMobile: true, content: '/handoff-review' })).toBe(true);
    expect(shouldClaimComposerGoal({ ...base, hasQueuedPrimary: true, content: '/undo' })).toBe(true);
    expect(shouldClaimComposerGoal({ ...base, content: '/summary' })).toBe(true);
  });

  test('uses only the primary queued message goal when batching', () => {
    const disarmed = { armed: false, objectiveOverride: null };
    const laterQueuedGoal = { armed: true, objectiveOverride: 'later queued goal' };
    const primaryQueuedGoal = { armed: true, objectiveOverride: 'primary queued goal' };

    expect(resolveSubmitGoalArm(disarmed, [
      { goalArm: disarmed },
      { goalArm: laterQueuedGoal },
    ])).toBe(disarmed);
    expect(resolveSubmitGoalArm(disarmed, [
      { goalArm: primaryQueuedGoal },
      { goalArm: laterQueuedGoal },
    ])).toBe(primaryQueuedGoal);
    expect(resolveSubmitGoalArm(disarmed, [], laterQueuedGoal)).toBe(laterQueuedGoal);
  });
});
