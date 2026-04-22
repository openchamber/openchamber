import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { getSnoozes, snoozeItem, unsnoozeItem, filterSnoozed } from '../snooze-store.js';

vi.mock('fs/promises');

describe('snooze-store', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('handles empty snooze store', async () => {
    vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });
    const snoozes = await getSnoozes();
    expect(snoozes).toEqual({});
  });

  it('reads snoozes', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('{"item1": 123}');
    const snoozes = await getSnoozes();
    expect(snoozes).toEqual({ item1: 123 });
  });

  it('adds snooze and filters correctly', async () => {
    let memoryStore = {};
    vi.mocked(fs.readFile).mockImplementation(async () => JSON.stringify(memoryStore));
    vi.mocked(fs.writeFile).mockImplementation(async (_, data) => {
      memoryStore = JSON.parse(data);
    });
    vi.mocked(fs.mkdir).mockResolvedValue();

    await snoozeItem('item1', Date.now() + 10000);
    await snoozeItem('item2', Date.now() - 10000); // Already expired

    const items = [{ id: 'item1' }, { id: 'item2' }, { id: 'item3' }];
    const filtered = await filterSnoozed(items, (i) => i.id);

    expect(filtered).toHaveLength(2);
    expect(filtered.map(i => i.id)).toEqual(['item2', 'item3']);
    
    // Check that expired item was removed
    const finalSnoozes = await getSnoozes();
    expect(finalSnoozes).toHaveProperty('item1');
    expect(finalSnoozes).not.toHaveProperty('item2');
  });
});
