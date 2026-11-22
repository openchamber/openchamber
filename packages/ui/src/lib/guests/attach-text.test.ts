import { describe, expect, test } from 'bun:test';

import { guestAttachContextText } from './attach-text.ts';

describe('guestAttachContextText', () => {
  test('names the item with its title', () => {
    expect(guestAttachContextText({ providerId: 'tasks-demo', id: 'DEMO-2', title: 'Fix login', url: 'https://tasks.example.com/tasks/DEMO-2' }))
      .toBe('Attached tasks-demo DEMO-2: Fix login\nhttps://tasks.example.com/tasks/DEMO-2');
  });

  test('a chat link chip whose title is its identifier does not repeat it', () => {
    expect(guestAttachContextText({ providerId: 'tasks-demo', id: 'DEMO-2', title: 'DEMO-2', url: 'https://tasks.example.com/tasks/DEMO-2' }))
      .toBe('Attached tasks-demo DEMO-2\nhttps://tasks.example.com/tasks/DEMO-2');
  });

  test('the extension text wins', () => {
    expect(guestAttachContextText({ providerId: 'p', id: 'A-1', title: 'A-1', url: 'https://x.example/a', text: 'custom' })).toBe('custom');
  });
});
