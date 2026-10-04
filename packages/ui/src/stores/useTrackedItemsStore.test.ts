import { beforeEach, describe, expect, test } from 'bun:test';
import { trackedItemKey, trackedItemRecordSchema, type TrackedItem } from '@/lib/trackedItems/model';
import { useTrackedItemsStore } from './useTrackedItemsStore';

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

  test('refuses a record whose key does not name its item, or whose state does not fit its kind', () => {
    expect(trackedItemRecordSchema.parse({ key: 'github|pull|other/repo#1', item, state: null, fetchedAt: 1 })).toBeNull();
    expect(trackedItemRecordSchema.parse({ key: trackedItemKey(item), item, state: { identifier: 'OPE-1' }, fetchedAt: 1 })).toBeNull();
    expect(trackedItemRecordSchema.parse({ key: trackedItemKey(item), item, state: null, fetchedAt: 1 })).toMatchObject({ record: { type: 'pull', state: null } });
  });
});
