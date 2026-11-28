import { describe, expect, test } from 'bun:test';

import { acmeTrackerDescriptor, linearLikeTrackerDescriptor } from '@/lib/trackers/descriptor.fixture';

import { DEFAULT_TRACKER_FILTER, normalizedTrackerFilter, trackerSavedFilterOptions } from './referencePickerItems';

const saved = [{ id: 'f-1', name: 'My queue' }, { id: 'f-2', name: 'Reported by me' }];

describe('the tracker filter', () => {
  test('keeps a saved filter only while the tracker declares the capability and still lists that filter', () => {
    const withSaved = linearLikeTrackerDescriptor({ capabilities: { ...linearLikeTrackerDescriptor().capabilities, filters: { people: true, priority: true, saved: true } } });
    expect(normalizedTrackerFilter({ ...DEFAULT_TRACKER_FILTER, saved: 'f-1' }, withSaved, saved).saved).toBe('f-1');
    expect(normalizedTrackerFilter({ ...DEFAULT_TRACKER_FILTER, saved: 'gone' }, withSaved, saved).saved).toBe('');
    expect(normalizedTrackerFilter({ ...DEFAULT_TRACKER_FILTER, saved: 'f-1' }, linearLikeTrackerDescriptor(), saved).saved).toBe('');
  });

  test('keeps the remembered filter until the provider list has answered', () => {
    const withSaved = linearLikeTrackerDescriptor({ capabilities: { ...linearLikeTrackerDescriptor().capabilities, filters: { people: true, priority: true, saved: true } } });
    expect(normalizedTrackerFilter({ ...DEFAULT_TRACKER_FILTER, saved: 'f-1' }, withSaved, [], false).saved).toBe('f-1');
    expect(normalizedTrackerFilter({ ...DEFAULT_TRACKER_FILTER, saved: 'f-1' }, withSaved, [], true).saved).toBe('');
    expect(normalizedTrackerFilter({ ...DEFAULT_TRACKER_FILTER, saved: 'f-1' }, linearLikeTrackerDescriptor(), [], false).saved).toBe('');
  });

  test('drops a filter the descriptor no longer offers', () => {
    const plain = acmeTrackerDescriptor();
    expect(normalizedTrackerFilter({ state: 'started', people: 'me', priority: 'high', saved: 'f-1' }, plain, saved)).toEqual(DEFAULT_TRACKER_FILTER);

    const withSaved = linearLikeTrackerDescriptor({ capabilities: { ...linearLikeTrackerDescriptor().capabilities, filters: { people: true, priority: true, saved: true } } });
    expect(normalizedTrackerFilter({ state: 'started', people: 'me', priority: 'high', saved: 'f-1' }, withSaved, saved)).toEqual({
      state: 'open', people: 'me', priority: 'high', saved: 'f-1',
    });
  });

  test('offers the saved filters after the choice that clears them', () => {
    expect(trackerSavedFilterOptions(saved, 'All')).toEqual([
      { value: '', label: 'All' },
      { value: 'f-1', label: 'My queue' },
      { value: 'f-2', label: 'Reported by me' },
    ]);
    expect(trackerSavedFilterOptions([], 'All')).toEqual([{ value: '', label: 'All' }]);
  });
});
