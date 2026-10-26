import { beforeEach, describe, expect, test } from 'bun:test';
import { trackedItemKey, trackedItemRecordSchema, type TrackedItem, type TrackedThread } from '@/lib/trackedItems/model';
import { readTrackedIssueState, useTrackedItemsStore } from './useTrackedItemsStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

const item: TrackedItem = { provider: 'gitlab', instance: 'https://gitlab.com', kind: 'pull', owner: 'group/sub', repo: 'app', number: 3 };
const pullState = (state: 'open' | 'merged', fetchedAt: number) => trackedItemRecordSchema.parse({
  key: trackedItemKey(item),
  item,
  state: { owner: 'group/sub', repo: 'app', number: 3, state, draft: false, title: 'MR', mergeable: null, mergeableState: null, checks: null },
  fetchedAt,
});

describe('tracked items store', () => {
  beforeEach(() => { useTrackedItemsStore.setState({ records: {} }); });

  test('keeps the newer answer when an older one lands after it', () => {
    const newer = pullState('merged', 200);
    const older = pullState('open', 100);
    if (!newer || !older) throw new Error('fixtures must parse');
    useTrackedItemsStore.getState().apply('runtime', [newer]);
    useTrackedItemsStore.getState().apply('runtime', [older]);
    const record = useTrackedItemsStore.getState().records[`runtime|${trackedItemKey(item)}`];
    expect(record?.type === 'pull' ? record.state?.state : null).toBe('merged');
  });

  test('reads a discussion the way an issue badge does: resolved is done, outdated and duplicate are dropped', () => {
    const discussion: TrackedThread<'discussion'> = { provider: 'github', instance: 'github.com', kind: 'discussion', owner: 'acme', repo: 'app', number: 5 };
    const record = (state: string, fetchedAt: number) => trackedItemRecordSchema.parse({
      key: trackedItemKey(discussion),
      item: discussion,
      state: { owner: 'acme', repo: 'app', number: 5, title: 'Idea', state, answered: null },
      fetchedAt,
    });
    const read = () => readTrackedIssueState(useTrackedItemsStore.getState().records, discussion)?.state;
    for (const [state, issueState, at] of [['open', 'open', 1], ['resolved', 'completed', 2], ['outdated', 'not_planned', 3], ['duplicate', 'not_planned', 4]] as const) {
      const parsed = record(state, at);
      if (!parsed) throw new Error('fixtures must parse');
      useTrackedItemsStore.getState().apply(getRuntimeKey(), [parsed]);
      expect(read()).toBe(issueState);
      // The same held state reads as the same object, so selectors over it settle.
      const records = useTrackedItemsStore.getState().records;
      expect(readTrackedIssueState(records, discussion)).toBe(readTrackedIssueState(records, discussion));
    }
    // A state no discussion has is refused, never guessed.
    expect(record('merged', 5)).toBeNull();
  });

  test('refuses a record whose key does not name its item, or whose state does not fit its kind', () => {
    expect(trackedItemRecordSchema.parse({ key: 'github|pull|other/repo#1', item, state: null, fetchedAt: 1 })).toBeNull();
    expect(trackedItemRecordSchema.parse({ key: trackedItemKey(item), item, state: { identifier: 'OPE-1' }, fetchedAt: 1 })).toBeNull();
    expect(trackedItemRecordSchema.parse({ key: trackedItemKey(item), item, state: null, fetchedAt: 1 })).toMatchObject({ record: { type: 'pull', state: null } });
  });
});
