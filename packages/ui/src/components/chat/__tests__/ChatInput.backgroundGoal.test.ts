import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

// ChatInput cannot be mounted in bun test (see useSessionGoalArmStore.test.ts),
// so the failure handling of a background goal send is guarded at the source.
// What restoreDraft does with the text is tested in
// useComposerDraft.backgroundRestore.test.ts; this pins where ChatInput sends
// it. Oracle: a failed background send never drops its text, and a draft that
// already created its session gives the text to that session instead of to
// whatever draft the user opened since.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ChatInput.tsx'), 'utf-8');

const block = (start: string, end: string): string => {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
};

describe('ChatInput background goal sends', () => {
  test('a failed goal restores the text to the created session, else to the composer it left', () => {
    const failed = block('if (error instanceof BackgroundGoalError) {', 'return;\n            }');
    expect(failed).toContain('backgroundSendJournal.remove(journalId)');
    expect(failed).toContain('const createdIdentity = createdSessionIdentity();');
    expect(failed).toContain('restoreDraft(createdIdentity, inputSnapshot.message, confirmedMentionsSnapshot)');
    expect(failed).toContain('restoreComposerText();');
    expect(failed).toContain('restoreAttachedFiles(allAttachments, restoreIdentity)');
  });

  test('any other failure of a background draft send restores to the created session too', () => {
    const other = block('// A send that failed for another reason', "toast.error(rawMessage || t('chat.chatInput.toast.messageSendFailed'));");
    expect(other).toContain('const backgroundSessionIdentity = backgroundGoal ? createdSessionIdentity() : null;');
    expect(other).toContain('restoreDraft(backgroundSessionIdentity, inputSnapshot.message, confirmedMentionsSnapshot)');
    expect(other).not.toContain('restoreAttachedFiles(allAttachments, chatDraftIdentity)');
  });

  test('the journal keeps the text from before the send until it settles, and follows the created session', () => {
    const recordAt = source.indexOf('backgroundSendJournal.record(');
    const sendAt = source.indexOf('const sendPromise = sessionActions.sendMessage(');
    expect(recordAt).toBeGreaterThan(0);
    expect(recordAt).toBeLessThan(sendAt);
    expect(source).toContain('backgroundSendJournal.retarget(journalId, identity)');
    const settled = block('void sendPromise.then(() => {', 'if (isBtwActive) return;');
    expect(settled).toContain('backgroundSendJournal.remove(journalId)');
  });

  test('the main composer gives back messages an earlier page left waiting', () => {
    const recovery = block('const recover = () => {', '};');
    expect(recovery).toContain('backgroundSendJournal.takeOrphans()');
    expect(recovery).toContain('recoverRef.current.restoreDraft(entry.identity, entry.text, new Set(entry.mentions))');
  });
});
