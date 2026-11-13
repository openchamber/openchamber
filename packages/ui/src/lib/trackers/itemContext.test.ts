import { describe, expect, test } from 'bun:test';

import { buildTrackerItemContextText } from './itemContext';
import type { TrackerItem } from './types';

const item: TrackerItem = {
  provider: 'acme-tickets',
  id: 'item-1',
  identifier: 'OPS-7',
  title: 'Outage',
  url: 'https://tickets.example.com/t/OPS-7',
  state: { id: null, name: 'Open', category: 'todo' },
  description: 'The API is down.',
  comments: [{ id: 'c1', body: 'Paged on-call', createdAt: null, author: { name: 'Ada', avatarUrl: null } }],
};

describe('buildTrackerItemContextText', () => {
  test('names the tracker and sends the item once, its comments beside it', () => {
    const text = buildTrackerItemContextText(item, 'Acme Tickets');
    expect(text.startsWith('Acme Tickets issue context (JSON)\n')).toBe(true);
    const payload = JSON.parse(text.slice(text.indexOf('\n') + 1));
    expect(payload.item.identifier).toBe('OPS-7');
    expect(payload.item.comments).toBeUndefined();
    expect(payload.comments).toEqual(item.comments);
  });

  test('an item read without comments sends an empty list', () => {
    const payload = JSON.parse(buildTrackerItemContextText({ ...item, comments: undefined }, 'Acme Tickets').split('\n').slice(1).join('\n'));
    expect(payload.comments).toEqual([]);
  });
});
