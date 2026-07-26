import { describe, expect, it, vi } from 'vitest';
import {
  buildUndoRedoDiffSection,
  executeMessengerRedo,
  executeMessengerUndo,
  formatRevertDiffBlock,
  resolveRedoAction,
  resolveUndoRevertMessageId,
} from './messenger-undo-redo.js';

function msg(role, id, parentID = undefined) {
  return { info: { role, id, parentID } };
}

describe('resolveUndoRevertMessageId', () => {
  it('targets the last user turn', () => {
    const messages = [
      msg('user', 'msg_1'),
      msg('assistant', 'msg_2', 'msg_1'),
      msg('user', 'msg_3'),
      msg('assistant', 'msg_4', 'msg_3'),
    ];
    expect(resolveUndoRevertMessageId(messages)).toBe('msg_3');
  });

  it('steps back before an existing revert cursor', () => {
    const messages = [
      msg('user', 'msg_1'),
      msg('assistant', 'msg_2', 'msg_1'),
      msg('user', 'msg_3'),
      msg('assistant', 'msg_4', 'msg_3'),
    ];
    expect(resolveUndoRevertMessageId(messages, 'msg_3')).toBe('msg_1');
  });

  it('falls back to the user message when no assistant reply exists', () => {
    expect(resolveUndoRevertMessageId([msg('user', 'msg_1')])).toBe('msg_1');
  });

  it('returns null when nothing is left to undo', () => {
    const messages = [msg('user', 'msg_1'), msg('assistant', 'msg_2', 'msg_1')];
    expect(resolveUndoRevertMessageId(messages, 'msg_1')).toBeNull();
  });
});

describe('resolveRedoAction', () => {
  it('moves the cursor to the next user message', () => {
    const messages = [msg('user', 'msg_1'), msg('user', 'msg_2'), msg('user', 'msg_3')];
    expect(resolveRedoAction(messages, 'msg_1')).toEqual({ kind: 'revert', messageId: 'msg_2' });
  });

  it('fully unreverts when no later user message exists', () => {
    expect(resolveRedoAction([msg('user', 'msg_1')], 'msg_1')).toEqual({ kind: 'unrevert' });
  });

  it('returns none without a revert cursor', () => {
    expect(resolveRedoAction([msg('user', 'msg_1')], null)).toEqual({ kind: 'none' });
  });
});

describe('formatRevertDiffBlock', () => {
  it('wraps a unified diff in a fenced block', () => {
    expect(formatRevertDiffBlock('diff --git a/a.ts b/a.ts\n+hi')).toContain('```diff');
    expect(formatRevertDiffBlock('')).toBe('');
  });
});

describe('buildUndoRedoDiffSection', () => {
  it('includes inline diff and a critique review URL when upload succeeds', async () => {
    const section = await buildUndoRedoDiffSection({
      diff: 'diff --git a/a.ts b/a.ts\n+hi',
      projectPath: '/repo',
      title: 'undo',
      uploadPatchFn: vi.fn(async () => ({ url: 'https://critique.work/v/abc', id: 'abc' })),
    });
    expect(section).toContain('**Files touched**');
    expect(section).toContain('```diff');
    expect(section).toContain('Review: https://critique.work/v/abc');
  });
});

describe('executeMessengerUndo / Redo', () => {
  it('undo sends the resolved messageID and returns a diff section', async () => {
    const revertSession = vi.fn(async () => ({
      ok: true,
      session: { revert: { messageID: 'msg_4', diff: 'diff --git a/x.ts b/x.ts\n-old\n+new' } },
    }));
    const opencode = {
      abortSession: vi.fn(async () => ({ ok: true })),
      getSession: vi.fn(async () => ({ id: 'ses', revert: null })),
      listMessages: vi.fn(async () => [
        msg('user', 'msg_1'),
        msg('assistant', 'msg_2', 'msg_1'),
        msg('user', 'msg_3'),
        msg('assistant', 'msg_4', 'msg_3'),
      ]),
      revertSession,
    };

    const result = await executeMessengerUndo({
      sessionId: 'ses',
      projectPath: '/repo',
      opencode,
      buildDiffSection: async ({ diff }) => `\nDIFF:${diff.slice(0, 20)}`,
    });

    expect(result.ok).toBe(true);
    expect(revertSession).toHaveBeenCalledWith('ses', 'msg_3', '/repo');
    expect(result.reply).toContain('✓ Reverted one turn.');
    expect(result.reply).toContain('DIFF:diff --git a/x.ts');
  });

  it('undo fails clearly when messageID cannot be resolved', async () => {
    const result = await executeMessengerUndo({
      sessionId: 'ses',
      opencode: {
        getSession: async () => null,
        listMessages: async () => [],
        revertSession: vi.fn(),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no messages to undo/i);
  });

  it('redo steps forward with messageID when a later user turn exists', async () => {
    const revertSession = vi.fn(async () => ({
      ok: true,
      session: { revert: { messageID: 'msg_2', diff: 'diff --git a/y.ts b/y.ts\n+y' } },
    }));
    const result = await executeMessengerRedo({
      sessionId: 'ses',
      projectPath: '/repo',
      opencode: {
        abortSession: vi.fn(async () => ({ ok: true })),
        getSession: vi.fn(async () => ({ revert: { messageID: 'msg_1' } })),
        listMessages: vi.fn(async () => [msg('user', 'msg_1'), msg('user', 'msg_2')]),
        revertSession,
        unrevertSession: vi.fn(),
      },
      buildDiffSection: async () => '\nDIFF',
    });
    expect(result.ok).toBe(true);
    expect(revertSession).toHaveBeenCalledWith('ses', 'msg_2', '/repo');
    expect(result.reply).toContain('Stepped forward');
    expect(result.reply).toContain('DIFF');
  });

  it('redo fully unreverts when at the end of history', async () => {
    const unrevertSession = vi.fn(async () => ({ ok: true, session: {} }));
    const result = await executeMessengerRedo({
      sessionId: 'ses',
      opencode: {
        getSession: async () => ({ revert: { messageID: 'msg_2' } }),
        listMessages: async () => [msg('user', 'msg_1'), msg('user', 'msg_2')],
        unrevertSession,
        revertSession: vi.fn(),
      },
      buildDiffSection: async () => '',
    });
    expect(result.ok).toBe(true);
    expect(unrevertSession).toHaveBeenCalled();
    expect(result.reply).toMatch(/fully back/i);
  });
});
