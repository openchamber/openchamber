import { expect, test } from 'bun:test';
import { createSavedPlanDrafts, type RetainedPlanBuffer } from './savedPlanDrafts';

const dirty = (): RetainedPlanBuffer => ({ content: 'draft', confirmedRaw: 'original', editRevision: 2, savedRevision: 0, deleted: false, saveError: 'Plan changed' });
const key = (runtime: string, owner: string, plan = 'A') => JSON.stringify(['saved-plan', runtime, owner, plan]);

test('retains the latest text, confirmed precondition and error in each runtime/owner/plan scope', () => {
  const drafts = createSavedPlanDrafts();
  const buffer = dirty();
  drafts.retain(key('host-a', 'owner-a'), buffer);
  buffer.content = 'latest draft';
  expect(drafts.restore(key('host-a', 'owner-a'))).toEqual(buffer);
  expect(drafts.restore(key('host-b', 'owner-a'))).toBeUndefined();
  expect(drafts.restore(key('host-a', 'owner-b'))).toBeUndefined();
  expect(drafts.restore(key('host-a', 'owner-a', 'B'))).toBeUndefined();
  expect(createSavedPlanDrafts().restore(key('host-a', 'owner-a'))).toBeUndefined();
});

test('successful save releases clean text but preserves newer edits and replacement buffers', () => {
  const drafts = createSavedPlanDrafts();
  const buffer = dirty();
  drafts.retain('A', buffer);
  buffer.savedRevision = 1;
  drafts.retain('A', buffer);
  expect(drafts.restore('A')).toBe(buffer);
  const replacement = dirty();
  drafts.retain('A', replacement);
  buffer.savedRevision = 2;
  drafts.retain('A', buffer);
  expect(drafts.restore('A')).toBe(replacement);
  replacement.savedRevision = 2;
  drafts.retain('A', replacement);
  expect(drafts.restore('A')).toBeUndefined();
});

test('deletion retires the retained buffer and cannot be undone by a late failure', () => {
  const drafts = createSavedPlanDrafts();
  const buffer = dirty();
  drafts.retain('A', buffer);
  drafts.deleted('A');
  expect(buffer.deleted).toBe(true);
  buffer.saveError = 'late failure';
  drafts.retain('A', buffer);
  expect(drafts.restore('A')).toBeUndefined();
});

test('unmounted runtime A-B-A retires queued writes while retaining text for a return', async () => {
  const drafts = createSavedPlanDrafts();
  const buffer = dirty();
  drafts.retain('A', buffer);
  let release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  const first = drafts.schedule('A', 1, buffer, () => pending);
  await Promise.resolve();
  const second = drafts.schedule('A', 2, buffer, async () => { writes++; });
  drafts.retire();
  drafts.retire();
  release();
  await Promise.all([first, second, drafts.queue.pendingFor('A')]);
  expect(writes).toBe(0);
  expect(drafts.restore('A')?.content).toBe('draft');
  drafts.queue.reset('A');
  await drafts.schedule('A', 1, buffer, async () => { writes++; });
  expect(writes).toBe(1);
});

test('authoritative deletion skips queued writes without recreating a draft', async () => {
  const drafts = createSavedPlanDrafts();
  const buffer = dirty();
  drafts.retain('A', buffer);
  let release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  const first = drafts.schedule('A', 1, buffer, () => pending);
  await Promise.resolve();
  const otherMountedBuffer = dirty();
  const second = drafts.schedule('A', 2, otherMountedBuffer, async () => { writes++; });
  drafts.deleted('A');
  expect(drafts.restore('A')).toBeUndefined();
  release();
  await Promise.all([first, second]);
  expect(writes).toBe(0);
  expect(drafts.restore('A')).toBeUndefined();
});

test('two mounted buffers keep distinct queue revisions and late failures preserve the latest text', async () => {
  const drafts = createSavedPlanDrafts();
  const first = { ...dirty(), editRevision: 0 };
  const second = { ...dirty(), editRevision: 0 };
  drafts.edit('A', first, 'first draft');
  drafts.edit('A', second, 'latest draft');
  const writes: string[] = [];
  const saveFirst = drafts.schedule('A', first.editRevision, first, async () => {
    first.saveError = 'late conflict';
    drafts.retain('A', first);
    writes.push(first.content);
  });
  const saveSecond = drafts.schedule('A', second.editRevision, second, async () => { writes.push(second.content); });
  await Promise.all([saveFirst, saveSecond]);
  expect(writes).toEqual(['first draft', 'latest draft']);
  expect(drafts.restore('A')).toBe(second);
});
