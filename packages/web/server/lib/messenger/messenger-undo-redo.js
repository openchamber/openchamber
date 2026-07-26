/**
 * Discord/messenger `/undo` + `/redo` helpers.
 *
 * OpenCode's `/session/:id/revert` requires `messageID`. We mirror the
 * OpenChamber UI / kimaki / OpenCode TUI cursor logic:
 *   - undo: revert to the last user message before the current revert point
 *   - redo: move the revert cursor to the next user message, or fully unrevert
 *
 * After a successful mutation we attach a reviewable diff for files touched by
 * the revert (from `session.revert.diff`) and, when possible, a critique.work URL.
 */

import { clipBlock } from './messenger-render.js';
import { uploadPatchViaCritique } from './messenger-critique.js';

const DIFF_PREVIEW_LIMIT = 1500;

function messageRole(message) {
  return message?.info?.role ?? message?.role ?? null;
}

function messageId(message) {
  return message?.info?.id ?? message?.id ?? message?.messageID ?? message?.messageId ?? null;
}

function sessionRevertMessageId(session) {
  return session?.revert?.messageID ?? session?.revert?.messageId ?? null;
}

function sessionRevertDiff(session) {
  const diff = session?.revert?.diff;
  return typeof diff === 'string' && diff.trim() ? diff : '';
}

/**
 * Pick the messageID OpenCode should revert to for one undo step.
 * Matches the OpenChamber UI: always target the user message for the turn
 * being undone so a subsequent `/undo` steps to the prior user turn
 * (`user.id < revert.messageID`).
 */
export function resolveUndoRevertMessageId(messages, currentRevertMessageId = null) {
  const list = Array.isArray(messages) ? messages : [];
  const userMessages = list.filter((m) => messageRole(m) === 'user' && messageId(m));
  const targetUser = [...userMessages].reverse().find((m) => {
    const id = messageId(m);
    return !currentRevertMessageId || (id && id < currentRevertMessageId);
  });
  return targetUser ? messageId(targetUser) : null;
}

/**
 * Pick the next redo target. Returns `{ kind: 'unrevert' }` when at the end of
 * history, or `{ kind: 'revert', messageId }` to step the cursor forward.
 */
export function resolveRedoAction(messages, currentRevertMessageId) {
  if (!currentRevertMessageId) return { kind: 'none' };
  const list = Array.isArray(messages) ? messages : [];
  const userMessages = list.filter((m) => messageRole(m) === 'user' && messageId(m));
  const nextUser = userMessages.find((m) => {
    const id = messageId(m);
    return id && id > currentRevertMessageId;
  });
  if (!nextUser) return { kind: 'unrevert' };
  return { kind: 'revert', messageId: messageId(nextUser) };
}

export function formatRevertDiffBlock(diff, { limit = DIFF_PREVIEW_LIMIT } = {}) {
  const raw = String(diff ?? '').trim();
  if (!raw) return '';
  const clipped = clipBlock(raw.replace(/```/g, "'''"), limit);
  return `\`\`\`diff\n${clipped}\n\`\`\``;
}

/**
 * Build the trailing "files touched" section for undo/redo replies.
 * Prefer a critique.work URL when upload succeeds; always keep an inline
 * preview when a revert.diff is available.
 */
export async function buildUndoRedoDiffSection({
  diff,
  projectPath,
  title,
  uploadPatchFn = uploadPatchViaCritique,
} = {}) {
  const lines = [];
  const inline = formatRevertDiffBlock(diff);
  if (inline) {
    lines.push('', '**Files touched**', inline);
  }

  if (projectPath && String(diff ?? '').trim()) {
    const uploaded = await uploadPatchFn({
      patch: diff,
      title: title || 'OpenChamber undo/redo',
      cwd: projectPath,
    }).catch(() => null);
    if (uploaded?.url) {
      lines.push('', `Review: ${uploaded.url}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

export async function executeMessengerUndo({
  sessionId,
  projectPath = null,
  opencode,
  buildDiffSection = buildUndoRedoDiffSection,
}) {
  if (!sessionId) return { ok: false, error: 'no session is active on this conversation.' };
  if (typeof opencode?.revertSession !== 'function' || typeof opencode?.listMessages !== 'function') {
    return { ok: false, error: 'undo is not available on this surface.' };
  }

  if (typeof opencode.abortSession === 'function') {
    await opencode.abortSession(sessionId, projectPath ?? undefined).catch(() => {});
  }

  const session = typeof opencode.getSession === 'function'
    ? await opencode.getSession(sessionId, projectPath ?? undefined).catch(() => null)
    : null;
  const messages = await opencode.listMessages(sessionId, projectPath ?? undefined).catch(() => []);
  const revertMessageId = resolveUndoRevertMessageId(messages, sessionRevertMessageId(session));
  if (!revertMessageId) return { ok: false, error: 'no messages to undo.' };

  let result = await opencode.revertSession(sessionId, revertMessageId, projectPath ?? undefined);
  if (!result?.ok && /busy|not idle/i.test(String(result?.error ?? ''))) {
    if (typeof opencode.abortSession === 'function') {
      await opencode.abortSession(sessionId, projectPath ?? undefined).catch(() => {});
    }
    result = await opencode.revertSession(sessionId, revertMessageId, projectPath ?? undefined);
  }
  if (!result?.ok) return { ok: false, error: result?.error ?? 'revert failed' };

  const diff = sessionRevertDiff(result.session) || sessionRevertDiff(result.data) || '';
  const section = await buildDiffSection({
    diff,
    projectPath,
    title: 'OpenChamber /undo',
  });
  return {
    ok: true,
    reply: `✓ Reverted one turn.${section}`,
    messageId: revertMessageId,
    diff,
  };
}

export async function executeMessengerRedo({
  sessionId,
  projectPath = null,
  opencode,
  buildDiffSection = buildUndoRedoDiffSection,
}) {
  if (!sessionId) return { ok: false, error: 'no session is active on this conversation.' };
  if (
    typeof opencode?.unrevertSession !== 'function'
    || typeof opencode?.listMessages !== 'function'
    || typeof opencode?.getSession !== 'function'
  ) {
    return { ok: false, error: 'redo is not available on this surface.' };
  }

  if (typeof opencode.abortSession === 'function') {
    await opencode.abortSession(sessionId, projectPath ?? undefined).catch(() => {});
  }

  const session = await opencode.getSession(sessionId, projectPath ?? undefined).catch(() => null);
  const currentRevert = sessionRevertMessageId(session);
  if (!currentRevert) return { ok: false, error: 'nothing to redo — no previous undo found.' };

  const messages = await opencode.listMessages(sessionId, projectPath ?? undefined).catch(() => []);
  const action = resolveRedoAction(messages, currentRevert);

  if (action.kind === 'none') {
    return { ok: false, error: 'nothing to redo — no previous undo found.' };
  }

  if (action.kind === 'unrevert') {
    const result = await opencode.unrevertSession(sessionId, projectPath ?? undefined);
    if (!result?.ok) return { ok: false, error: result?.error ?? 'redo failed' };
    const diff = sessionRevertDiff(result.session) || '';
    const section = await buildDiffSection({
      diff,
      projectPath,
      title: 'OpenChamber /redo',
    });
    return {
      ok: true,
      reply: `✓ Restored — session fully back to the previous state.${section}`,
      diff,
    };
  }

  let result = await opencode.revertSession(sessionId, action.messageId, projectPath ?? undefined);
  if (!result?.ok && /busy|not idle/i.test(String(result?.error ?? ''))) {
    if (typeof opencode.abortSession === 'function') {
      await opencode.abortSession(sessionId, projectPath ?? undefined).catch(() => {});
    }
    result = await opencode.revertSession(sessionId, action.messageId, projectPath ?? undefined);
  }
  if (!result?.ok) return { ok: false, error: result?.error ?? 'redo failed' };

  const diff = sessionRevertDiff(result.session) || sessionRevertDiff(result.data) || '';
  const section = await buildDiffSection({
    diff,
    projectPath,
    title: 'OpenChamber /redo',
  });
  return {
    ok: true,
    reply: `✓ Stepped forward one turn.${section}`,
    messageId: action.messageId,
    diff,
  };
}
