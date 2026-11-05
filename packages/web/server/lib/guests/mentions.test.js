import { describe, expect, test, vi } from 'vitest';

import { isMentionGuest, resolveGuestMention, searchGuestMentions } from './mentions.js';

const row = (id, overrides = {}) => ({
  id,
  name: id,
  packageRoot: `/pkg/${id}`,
  enabled: true,
  mentions: { label: `${id} notes` },
  service: { entry: 'service/main.js', runtime: 'host' },
  capabilityGrants: ['service'],
  ...overrides,
});

const answering = (byGuest) => vi.fn(async ({ guestId }) => {
  const answer = byGuest[guestId];
  if (answer instanceof Error) throw answer;
  return answer;
});
const json = (body, status = 200) => ({ status, body: JSON.stringify(body) });

describe('extension rows in the @ menu', () => {
  test('a paused or unapproved extension is not asked', () => {
    expect(isMentionGuest(row('a'))).toBe(true);
    expect(isMentionGuest(row('a', { enabled: false }))).toBe(false);
    expect(isMentionGuest(row('a', { capabilityGrants: [] }))).toBe(false);
  });

  test('one that fails, answers badly or says nothing leaves the others in the menu', async () => {
    const callService = answering({
      good: json({ items: [{ id: '1', title: 'Release' }] }),
      down: new Error('timeout'),
      bad: json({ items: [{ title: 'no id' }] }),
      refused: json({ items: [{ id: '2', title: 'x' }] }, 500),
      empty: json({ items: [] }),
    });
    const guests = ['good', 'down', 'bad', 'refused', 'empty'].map((id) => row(id));
    const groups = await searchGuestMentions({ guests, query: 'rel', directory: '/repo', persistPath: '/s', callService });
    expect(groups).toEqual([{ guestId: 'good', label: 'good notes', items: [{ id: '1', title: 'Release' }] }]);
  });

  test('a row too long to show stays out alone', async () => {
    const callService = answering({ good: json({ items: [{ id: '1', title: 'x', subtitle: 'y'.repeat(121) }, { id: '2', title: 'Release' }] }) });
    const groups = await searchGuestMentions({ guests: [row('good')], query: '', directory: null, persistPath: '/s', callService });
    expect(groups[0].items).toEqual([{ id: '2', title: 'Release' }]);
  });

  test('a search asks within the short deadline, with the query and the project', async () => {
    const callService = answering({ good: json({ items: [] }) });
    await searchGuestMentions({ guests: [row('good')], query: 'rel', directory: '/repo', persistPath: '/s', callService });
    const [params] = callService.mock.calls[0];
    expect(params.timeoutMs).toBe(2_000);
    expect(JSON.parse(params.body)).toEqual({ query: 'rel', directory: '/repo' });
  });

  test('a row with a link outside http stays out', async () => {
    const callService = answering({ good: json({ items: [{ id: '1', title: 'x', url: 'javascript:alert(1)' }] }) });
    expect(await searchGuestMentions({ guests: [row('good')], query: '', directory: null, persistPath: '/s', callService })).toEqual([]);
  });

  test('a picked row gives its text', async () => {
    const callService = answering({ good: json({ text: 'Ships Thursday' }) });
    expect(await resolveGuestMention({ guest: row('good'), id: '1', persistPath: '/s', callService })).toBe('Ships Thursday');
  });

  test('a picked row that gives no text fails, so no empty chip goes out', async () => {
    const callService = answering({ good: json({ text: '' }) });
    await expect(resolveGuestMention({ guest: row('good'), id: '1', persistPath: '/s', callService })).rejects.toThrow('no text');
  });
});
