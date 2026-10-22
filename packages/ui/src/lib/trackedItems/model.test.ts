import { describe, expect, test } from 'bun:test';

import { trackedItemKey, trackedItemRecordSchema, trackedItemRecordsSchema } from './model';

const liveState = { identifier: 'ENG-12', title: 'Broken login', state: { name: 'In Progress', category: 'in-progress' } };

describe('tracked work items', () => {
  test('a record from the server names its tracker and reads its state by category', () => {
    const record = trackedItemRecordSchema.parse({
      key: 'linear|ENG-12',
      item: { provider: 'linear', kind: 'work-item', identifier: 'ENG-12' },
      // Linear's raw `state.type` rides along for older phone UIs; it is dropped here.
      state: { ...liveState, state: { ...liveState.state, type: 'started' } },
      fetchedAt: 5,
    });
    expect(record).toEqual({
      key: 'linear|ENG-12',
      record: { type: 'work-item', item: { provider: 'linear', kind: 'work-item', identifier: 'ENG-12' }, state: liveState, fetchedAt: 5 },
    });
  });

  test('a Linear record stored before work items had a kind parses, under the same key', () => {
    const record = trackedItemRecordSchema.parse({ key: 'linear|ENG-12', item: { provider: 'linear', identifier: 'ENG-12' }, state: null, fetchedAt: 1 });
    expect(record?.record).toEqual({ type: 'work-item', item: { provider: 'linear', kind: 'work-item', identifier: 'ENG-12' }, state: null, fetchedAt: 1 });
    expect(trackedItemKey({ provider: 'linear', kind: 'work-item', identifier: 'eng-12' })).toBe('linear|ENG-12');
  });

  // Stored records are checked for id syntax only; which ids are trackers is
  // the registry's answer at read time, where a source-control id is none.
  test('any tracker id keys as provider|IDENTIFIER; a reserved id is no tracker', () => {
    expect(trackedItemKey({ provider: 'acme-tickets', kind: 'work-item', identifier: 'ops-7' })).toBe('acme-tickets|OPS-7');
    expect(trackedItemRecordSchema.parse({ key: 'guest|ENG-1', item: { provider: 'guest', kind: 'work-item', identifier: 'ENG-1' }, state: null, fetchedAt: 1 })).toBeNull();
  });

  // A server before trackers, and records stored before then, send Linear's
  // `{ name, type }` with no category: the state is read by that type.
  test('a state in the old Linear shape reads by its type; one that cannot be read drops only its record', () => {
    const records = trackedItemRecordsSchema.parse([
      { key: 'linear|ENG-1', item: { provider: 'linear', identifier: 'ENG-1' }, state: { identifier: 'ENG-1', title: 'Old', state: { name: 'Done', type: 'completed' } }, fetchedAt: 1 },
      { key: 'linear|ENG-2', item: { provider: 'linear', kind: 'work-item', identifier: 'ENG-2' }, state: { ...liveState, identifier: 'ENG-2' }, fetchedAt: 2 },
      { key: 'linear|ENG-3', item: { provider: 'linear', identifier: 'ENG-3' }, state: { identifier: 'ENG-3', title: 'Odd', state: { name: 'Odd', type: 'unheard-of' } }, fetchedAt: 3 },
    ]);
    expect(records.map((entry) => [entry.key, entry.record.state?.state])).toEqual([
      ['linear|ENG-1', { name: 'Done', category: 'done' }],
      ['linear|ENG-2', { name: 'In Progress', category: 'in-progress' }],
    ]);
    const started = trackedItemRecordSchema.parse({
      key: 'linear|ENG-12',
      item: { provider: 'linear', identifier: 'ENG-12' },
      state: { identifier: 'ENG-12', title: 'Broken login', state: { name: 'In Progress', type: 'started' } },
      fetchedAt: 4,
    });
    expect(started?.record.state).toEqual(liveState);
  });
});
