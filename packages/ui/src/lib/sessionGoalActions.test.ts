import { describe, expect, mock, test } from 'bun:test';
import type { Metadata } from '@/lib/opencode/model';
import type { SessionGoalPayload } from '@/lib/sessionGoalMetadata';
import type { GoalObjectiveSnapshot } from './goalObjectiveFiles';
import { SESSION_GOAL_CHAR_LIMIT_MAX } from './sessionGoalLimits';

// setSessionGoal harness: the save reads and writes through the session
// metadata store and the objective file store. Both are kept in memory here
// so a test can land an intervening change between the pre-check read and
// the guarded metadata write — the window #1372 is about.
let storedMetadata: Metadata = {};
let objectiveFileContent: string | null = null;
let completeGoalBeforeMetadataWrite = false;
let winnerSaveBeforeMetadataWrite: string | null = null;
let snapshotReadFails = false;
let snapshotReadHook: (() => void) | null = null;
const objectiveFileWrites: string[] = [];
/** The `record` option of each write; true when not passed. */
const objectiveFileWriteRecords: boolean[] = [];
let objectiveFileDeletes = 0;
const objectiveVersionDeletes: string[] = [];
let nextVersionId = 0;
let distillResult: string | null = null;
let objectiveFileSaveFails = false;

const resetGoalHarness = (goal: Metadata, fileContent: string | null) => {
  storedMetadata = { openchamber: { goal } };
  objectiveFileContent = fileContent;
  completeGoalBeforeMetadataWrite = false;
  winnerSaveBeforeMetadataWrite = null;
  snapshotReadFails = false;
  snapshotReadHook = null;
  objectiveFileWrites.length = 0;
  objectiveFileWriteRecords.length = 0;
  objectiveFileDeletes = 0;
  objectiveVersionDeletes.length = 0;
  nextVersionId = 0;
  distillResult = null;
  objectiveFileSaveFails = false;
};

mock.module('@/sync/session-actions', () => ({
  abortCurrentOperation: () => undefined,
  patchSessionMetadata: async (
    _sessionId: string,
    _directory: string | undefined,
    updater: (metadata: Metadata) => Metadata,
  ) => {
    if (completeGoalBeforeMetadataWrite) {
      // SAFETY: the harness only ever stores `{ openchamber: { goal } }` in
      // storedMetadata, so both narrowings name the shape it just wrote.
      const namespace = storedMetadata.openchamber as Metadata;
      // SAFETY: the harness placed the goal record at this key itself.
      const goal = namespace.goal as Metadata;
      storedMetadata = { openchamber: { goal: { ...goal, status: 'complete' } } };
    }
    if (winnerSaveBeforeMetadataWrite !== null) {
      // Another window's save commits between this save's objective-file
      // write and its guarded metadata write: the winner's text is in the
      // file and the winner's revision is in the record.
      // SAFETY: same harness-owned shape as above.
      const namespace = storedMetadata.openchamber as Metadata;
      // SAFETY: the harness placed the goal record at this key itself.
      const goal = namespace.goal as Metadata;
      objectiveFileContent = winnerSaveBeforeMetadataWrite;
      storedMetadata = {
        openchamber: {
          goal: { ...goal, objectiveRevision: goalObjectiveRevision(winnerSaveBeforeMetadataWrite) },
        },
      };
    }
    storedMetadata = updater(storedMetadata);
    return { metadata: storedMetadata };
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getSession: async () => ({ metadata: storedMetadata }),
  },
}));

mock.module('@/lib/goalObjectiveFiles', () => ({
  fetchGoalObjectiveContent: async () => objectiveFileContent,
  fetchGoalObjectiveSnapshot: async (): Promise<GoalObjectiveSnapshot> => {
    snapshotReadHook?.();
    if (snapshotReadFails) return { kind: 'unavailable' };
    return objectiveFileContent === null
      ? { kind: 'missing' }
      : { kind: 'content', content: objectiveFileContent };
  },
  writeGoalObjectiveFile: async (_sessionId: string, content: string, options?: { record?: boolean }) => {
    if (objectiveFileSaveFails) return { saved: false, truncated: false, versionId: null };
    objectiveFileWrites.push(content);
    objectiveFileWriteRecords.push(options?.record !== false);
    objectiveFileContent = content;
    // Each recording write returns a fresh version id, like the server.
    nextVersionId += 1;
    return { saved: true, truncated: false, versionId: options?.record === false ? null : `v${nextVersionId}` };
  },
  deleteGoalObjectiveVersion: (_sessionId: string, versionId: string) => {
    objectiveVersionDeletes.push(versionId);
  },
  deleteGoalObjectiveFile: () => {
    objectiveFileDeletes += 1;
    objectiveFileContent = null;
  },
}));

mock.module('@/lib/smallModel', () => ({
  distillGoalObjective: async () => distillResult,
}));

mock.module('@/lib/goalWriter', () => ({
  requestGoalSpec: async () => ({ ok: false, message: 'writer unused in these tests' }),
}));

mock.module('@/lib/i18n', () => ({
  formatMessage: () => '',
  useI18nStore: { getState: () => ({ dictionary: {} }) },
}));

mock.module('@/components/ui', () => ({
  toast: { error: () => undefined, success: () => undefined },
}));

mock.module('@/stores/useUIStore', () => ({
  useUIStore: { getState: () => ({ sessionGoalObjectiveCharLimit: 100_000 }) },
}));

const { goalObjectiveRevision, nextGoalRecord, setSessionGoal } = await import('./sessionGoalActions');

const existing: SessionGoalPayload = {
  id: 'goal-1',
  objective: 'Old objective',
  objectiveFile: true,
  objectiveRevision: 'rev-a',
  ignoreObjectiveLimit: false,
  status: 'active',
  tokenBudget: null,
  tokensUsed: 900,
  turnsUsed: 4,
  statusReason: '',
  evaluationProviderID: '',
  evaluationModelID: '',
  lastAccountedMessageID: 'msg-9',
  createdAt: 1,
  updatedAt: 50,
};

const stored = { id: 'goal-1', status: 'active', updatedAt: 50, tokensUsed: 900, turnsUsed: 4, lastAccountedMessageID: 'msg-9' };

const save = (currentGoal: Metadata | null, overrides: Partial<Parameters<typeof nextGoalRecord>[0]> = {}) => nextGoalRecord({
  currentGoal,
  existing,
  objective: '',
  objectiveFile: true,
  objectiveRevision: 'rev-new',
  ignoreLimit: false,
  tokenBudget: null,
  kickoff: true,
  now: 100,
  newId: 'goal-2',
  ...overrides,
});

describe('goal record for a save', () => {
  test('an edit keeps the goal and its usage, and reactivates it', () => {
    expect(save(stored)).toMatchObject({
      changed: false,
      record: { id: 'goal-1', tokensUsed: 900, turnsUsed: 4, status: 'active', statusReason: 'resumed', updatedAt: 100 },
    });
  });

  test('an edit sent with a message does not ask for an immediate check', () => {
    const next = save(stored, { kickoff: false });
    expect(next.changed ? null : next.record.statusReason).toBe('');
  });

  // A rewrite can take minutes: the check may complete the goal, the user may
  // pause it, another window may replace it. Saving over any of those would
  // reactivate an outcome or reset another goal's usage.
  // The server runtime stamps a fresh updatedAt on every accounting
  // merge-write, so a settlement landing while the editor is open must not
  // read as somebody else editing the goal.
  test('an accounting bump after the edit began is not a conflicting edit', () => {
    const next = save({ ...stored, updatedAt: 999, tokensUsed: 1500, turnsUsed: 5, lastAccountedMessageID: 'msg-10' });
    expect(next).toMatchObject({ changed: false, record: { id: 'goal-1', tokensUsed: 1500, turnsUsed: 5 } });
  });

  test('a genuine objective change after the edit began is still refused', () => {
    const inlineExisting = { ...existing, objectiveFile: false };
    expect(save({ ...stored, objective: 'Old objective' }, { existing: inlineExisting }).changed).toBe(false);
    expect(save({ ...stored, objective: 'Rewritten elsewhere' }, { existing: inlineExisting })).toEqual({ changed: true });
  });

  // File-backed goals carry no objective text in the record, so an
  // intervening save is detected by the objective revision it stamps:
  // accounting preserves the revision, a save replaces it.
  test('a file-backed goal whose objective was saved elsewhere is refused', () => {
    expect(save({ ...stored, objectiveRevision: 'rev-b', updatedAt: 999 })).toEqual({ changed: true });
  });

  test('an accounting bump on a file-backed goal keeps its revision and is not a conflict', () => {
    const next = save({ ...stored, objectiveRevision: 'rev-a', updatedAt: 999, tokensUsed: 1500 });
    expect(next).toMatchObject({ changed: false, record: { objectiveRevision: 'rev-new', tokensUsed: 1500 } });
  });

  // Budget and limit flag are user-editable settings an accounting
  // merge-write cannot change; another window lowering the budget while
  // this edit is open is a real conflict, not an accounting bump.
  test('a budget or limit change after the edit began is a conflicting edit', () => {
    expect(save({ ...stored, tokenBudget: 5000 })).toEqual({ changed: true });
    expect(save({ ...stored, ignoreObjectiveLimit: true })).toEqual({ changed: true });
  });

  test('an edit begun after the budget was set still saves over accounting bumps', () => {
    const budgeted = { ...existing, tokenBudget: 5000, ignoreObjectiveLimit: true };
    const next = save(
      { ...stored, tokenBudget: 5000, ignoreObjectiveLimit: true, updatedAt: 999, tokensUsed: 1500 },
      { existing: budgeted },
    );
    expect(next).toMatchObject({ changed: false, record: { id: 'goal-1', tokensUsed: 1500 } });
  });

  test('an edit is refused when the stored goal changed after it began', () => {
    expect(save({ ...stored, status: 'complete' })).toEqual({ changed: true });
    expect(save({ ...stored, status: 'paused', updatedAt: 60 })).toEqual({ changed: true });
    expect(save({ ...stored, id: 'goal-other' })).toEqual({ changed: true });
    expect(save(null)).toEqual({ changed: true });
  });

  test('a new goal states its length limit choice, so the replaced goal cannot pass it on', () => {
    const next = save({ ...stored, ignoreObjectiveLimit: true }, { existing: null });
    expect(next).toMatchObject({
      changed: false,
      record: { id: 'goal-2', ignoreObjectiveLimit: false, tokensUsed: 0, turnsUsed: 0, statusReason: '' },
    });
  });
});

const priorText = 'Prior objective text';
const newText = 'New objective text';

const storedGoal = (overrides: Metadata = {}): Metadata => ({
  id: 'goal-1',
  status: 'active',
  objective: '',
  objectiveFile: true,
  objectiveRevision: goalObjectiveRevision(priorText),
  tokensUsed: 900,
  turnsUsed: 4,
  lastAccountedMessageID: 'msg-9',
  updatedAt: 50,
  ...overrides,
});

const editPayload = (): SessionGoalPayload => ({
  ...existing,
  objectiveRevision: goalObjectiveRevision(priorText),
});

// SAFETY: the harness only ever stores `{ openchamber: { goal } }`, so
// this reads back the goal record the harness itself placed there.
const storedGoalNow = (): Metadata => (storedMetadata.openchamber as Metadata).goal as Metadata;

describe('session-goal save against the objective file', () => {
  // The check completing the goal while this save is in flight aborts the
  // metadata write; before #1372 the aborted save had already overwritten
  // the objective file, leaving the surviving goal pointing at text its
  // stored revision does not describe.
  test('an intervening completion aborts the save and leaves the objective file byte-identical', async () => {
    resetGoalHarness(storedGoal(), priorText);
    completeGoalBeforeMetadataWrite = true;
    const result = await setSessionGoal('session-1', undefined, { objective: newText, tokenBudget: null }, editPayload());
    expect(result).toEqual({ outcome: 'changed' });
    expect(objectiveFileContent).toBe(priorText);
    expect(storedGoalNow().status).toBe('complete');
    expect(storedGoalNow().objectiveRevision).toBe(goalObjectiveRevision(priorText));
  });

  test('an aborted save with no prior objective file deletes the file it wrote', async () => {
    resetGoalHarness(storedGoal(), null);
    completeGoalBeforeMetadataWrite = true;
    const result = await setSessionGoal('session-1', undefined, { objective: newText, tokenBudget: null }, editPayload());
    expect(result).toEqual({ outcome: 'changed' });
    expect(objectiveFileWrites).toEqual([newText]);
    expect(objectiveFileDeletes).toBe(1);
    expect(objectiveFileContent).toBeNull();
  });

  // #1830: the aborted write recorded a version the goal never held; the
  // rollback restores the file without recording and drops that version.
  test('an aborted save does not leave a version, and its restore records none', async () => {
    resetGoalHarness(storedGoal(), priorText);
    completeGoalBeforeMetadataWrite = true;
    const result = await setSessionGoal('session-1', undefined, { objective: newText, tokenBudget: null }, editPayload());
    expect(result).toEqual({ outcome: 'changed' });
    // The aborted write recorded v1; the restore wrote without recording.
    expect(objectiveFileWrites).toEqual([newText, priorText]);
    expect(objectiveFileWriteRecords).toEqual([true, false]);
    expect(objectiveVersionDeletes).toEqual(['v1']);
  });

  test('a save with no intervening change writes the new objective and keeps it', async () => {
    resetGoalHarness(storedGoal(), priorText);
    const result = await setSessionGoal('session-1', undefined, { objective: newText, tokenBudget: null }, editPayload());
    expect(result).toEqual({ outcome: 'saved', rewrittenSpec: null });
    expect(objectiveFileContent).toBe(newText);
    expect(objectiveFileDeletes).toBe(0);
    expect(storedGoalNow().objectiveRevision).toBe(goalObjectiveRevision(newText));
  });

  // Codex P1 on PR #1479: the rollback used to restore unconditionally, so
  // a save that committed after this save's file write but before its
  // metadata check lost its objective file to this save's restore.
  test('a newer committed save between the file write and the abort keeps its objective file', async () => {
    const winnerText = 'Winner objective text';
    resetGoalHarness(storedGoal(), priorText);
    winnerSaveBeforeMetadataWrite = winnerText;
    const result = await setSessionGoal('session-1', undefined, { objective: newText, tokenBudget: null }, editPayload());
    expect(result).toEqual({ outcome: 'changed' });
    expect(objectiveFileContent).toBe(winnerText);
    expect(objectiveFileWrites).toEqual([newText]);
    expect(objectiveFileDeletes).toBe(0);
    expect(storedGoalNow().objectiveRevision).toBe(goalObjectiveRevision(winnerText));
  });

  // Codex P1 on PR #1479: a snapshot read that fails transiently answers
  // null exactly like a missing file; treating it as missing would let the
  // save write over a live objective and, on abort, delete it.
  test('a failed snapshot read stops the save before any file write', async () => {
    resetGoalHarness(storedGoal(), priorText);
    snapshotReadFails = true;
    await expect(
      setSessionGoal('session-1', undefined, { objective: newText, tokenBudget: null }, editPayload()),
    ).rejects.toThrow('Could not read the current goal objective');
    expect(objectiveFileWrites).toEqual([]);
    expect(objectiveFileDeletes).toBe(0);
    expect(objectiveFileContent).toBe(priorText);
  });

  // Codex P2 on PR #1479: a cancel landing while the snapshot read is in
  // flight must stop the save before its first write.
  test('a cancel during the snapshot read stops the save before any file write', async () => {
    resetGoalHarness(storedGoal(), priorText);
    const controller = new AbortController();
    snapshotReadHook = () => controller.abort();
    await expect(
      setSessionGoal('session-1', undefined, { objective: newText, tokenBudget: null, signal: controller.signal }, editPayload()),
    ).rejects.toThrow();
    expect(objectiveFileWrites).toEqual([]);
    expect(objectiveFileContent).toBe(priorText);
  });

  test('a goal already changed at the pre-check is refused before any file write', async () => {
    resetGoalHarness(storedGoal({ status: 'paused' }), priorText);
    const result = await setSessionGoal('session-1', undefined, { objective: newText, tokenBudget: null }, editPayload());
    expect(result).toEqual({ outcome: 'changed' });
    expect(objectiveFileWrites).toEqual([]);
    expect(objectiveFileContent).toBe(priorText);
  });
});

// #2044: every fixed-offset cut in the objective fit must move a boundary
// that lands inside a surrogate pair back to the pair boundary, or the lone
// surrogate bakes into the stored objective as U+FFFD. Each case straddles
// an astral character across its cut and asserts the written text carries no
// lone surrogate and no replacement character after a UTF-8 round-trip.
describe('objective fitting never splits a surrogate pair', () => {
  const UI_LIMIT = 100_000;
  // A lone surrogate is a high surrogate not followed by a low one, or a
  // low surrogate not preceded by a high one.
  const hasLoneSurrogate = (text: string): boolean =>
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
  const roundTripsClean = (text: string): boolean =>
    !new TextDecoder().decode(new TextEncoder().encode(text)).includes('�');

  test('the ignoreLimit cut drops a straddling pair instead of keeping a lone high surrogate', async () => {
    resetGoalHarness(storedGoal(), priorText);
    // Cut at SESSION_GOAL_CHAR_LIMIT_MAX lands between the pair halves.
    const raw = `${'a'.repeat(SESSION_GOAL_CHAR_LIMIT_MAX - 1)}😀${'b'.repeat(100)}`;
    const result = await setSessionGoal(
      'session-1',
      undefined,
      { objective: raw, ignoreLimit: true, tokenBudget: null },
      editPayload(),
    );
    expect(result).toEqual({ outcome: 'saved', rewrittenSpec: null });
    const written = objectiveFileWrites[0];
    expect(written).toBe('a'.repeat(SESSION_GOAL_CHAR_LIMIT_MAX - 1));
    expect(hasLoneSurrogate(written)).toBe(false);
    expect(roundTripsClean(written)).toBe(true);
  });

  test('the distilled cut drops a straddling pair', async () => {
    resetGoalHarness(storedGoal(), priorText);
    // Distillation answers over the limit with the pair straddling the cut.
    distillResult = `${'x'.repeat(UI_LIMIT - 1)}😀${'y'.repeat(100)}`;
    try {
      const result = await setSessionGoal(
        'session-1',
        undefined,
        { objective: `${'z'.repeat(UI_LIMIT + 1)}`, tokenBudget: null },
        editPayload(),
      );
      expect(result).toEqual({ outcome: 'saved', rewrittenSpec: null });
      const written = objectiveFileWrites[0];
      expect(written).toBe('x'.repeat(UI_LIMIT - 1));
      expect(hasLoneSurrogate(written)).toBe(false);
      expect(roundTripsClean(written)).toBe(true);
    } finally {
      distillResult = null;
    }
  });

  test('the head/tail fallback drops both straddling halves and keeps the trim marker', async () => {
    resetGoalHarness(storedGoal(), priorText);
    // half is 49953 at the mocked 100000 limit: the head cut lands between
    // the first pair's halves and the tail cut between the second pair's.
    const raw = `${'a'.repeat(49952)}😀${'m'.repeat(200)}😀${'b'.repeat(49952)}`;
    const result = await setSessionGoal(
      'session-1',
      undefined,
      { objective: raw, tokenBudget: null },
      editPayload(),
    );
    expect(result).toEqual({ outcome: 'saved', rewrittenSpec: null });
    const written = objectiveFileWrites[0];
    expect(written).toContain('objective trimmed for the auditor');
    expect(written.length).toBeLessThanOrEqual(UI_LIMIT);
    expect(hasLoneSurrogate(written)).toBe(false);
    expect(roundTripsClean(written)).toBe(true);
  });

  test('the inline cut drops a straddling pair when the objective file write fails', async () => {
    resetGoalHarness(storedGoal(), priorText);
    objectiveFileSaveFails = true;
    // ignoreLimit fits near a million characters; the inline cut back down
    // to the UI limit lands between the pair halves.
    const raw = `${'a'.repeat(UI_LIMIT - 1)}😀${'c'.repeat(SESSION_GOAL_CHAR_LIMIT_MAX)}`;
    const result = await setSessionGoal(
      'session-1',
      undefined,
      { objective: raw, ignoreLimit: true, tokenBudget: null },
      editPayload(),
    );
    expect(result).toEqual({ outcome: 'saved', rewrittenSpec: null });
    expect(objectiveFileWrites).toEqual([]);
    // Exact equality with a pair-boundary string: the pre-fix cut kept the
    // lone high surrogate in place of the emoji, so this fails without the fix.
    expect(storedGoalNow().objective).toBe('a'.repeat(UI_LIMIT - 1));
  });

  test('under-limit and ASCII objectives pass through byte-identical', async () => {
    resetGoalHarness(storedGoal(), priorText);
    const result = await setSessionGoal(
      'session-1',
      undefined,
      { objective: 'Plain ASCII objective under the limit', tokenBudget: null },
      editPayload(),
    );
    expect(result).toEqual({ outcome: 'saved', rewrittenSpec: null });
    expect(objectiveFileWrites).toEqual(['Plain ASCII objective under the limit']);
  });
});
