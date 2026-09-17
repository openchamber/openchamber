import { describe, expect, test } from 'bun:test';
import { GUEST_ITEM_MESSAGE_TEXT_MAX, GUEST_ITEM_SESSION_MAX } from '@openchamber/sdk';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import {
  buildGuestMessageItem,
  buildGuestSessionItem,
  guestActionEntries,
  guestMessageActionsFor,
  guestSessionActions,
} from './actions.ts';
import type { InstalledGuest } from './types.ts';

// SAFETY: the builders under test read only id, role, time.created, and the
// text parts; the rest of an OpenCode message record never enters the item.
const record = (id: string, role: 'user' | 'assistant', text: string, created = 1) => ({
  info: { id, role, sessionID: 'ses-1', time: { created } } as Message,
  parts: [{ id: `${id}-p`, sessionID: 'ses-1', messageID: id, type: 'text', text } as Part],
});

const session = { sessionId: 'ses-1', sessionTitle: '  Hello  ', directory: '/repo' };

const guest = (id: string, overrides: Partial<InstalledGuest> = {}): InstalledGuest => ({
  id,
  name: id,
  icon: 'window',
  entry: 'panel/index.html',
  capabilities: { requested: [], granted: [] },
  ...overrides,
});

describe('guestActionEntries', () => {
  test('lists actions of active guests only and filters by where and role', () => {
    const entries = guestActionEntries([
      guest('a', {
        actions: [
          { id: 'm-any', label: 'Any message', where: 'message' },
          { id: 'm-assistant', label: 'Assistant only', where: 'message', roles: ['assistant'], icon: 'task' },
          { id: 's', label: 'Session', where: 'session', payload: ['messages'] },
        ],
        capabilities: { requested: ['conversation'], granted: ['conversation'] },
      }),
      guest('paused', { enabled: false, actions: [{ id: 'x', label: 'X', where: 'message' }] }),
      guest('pending', {
        actions: [{ id: 'x', label: 'X', where: 'session', payload: ['messages'] }],
        capabilities: { requested: ['conversation'], granted: [] },
      }),
    ], (path) => `asset:${path}`);
    expect(entries.map((entry) => `${entry.guest.id}/${entry.action.id}`)).toEqual(['a/m-any', 'a/m-assistant', 'a/s']);
    expect(entries[1]?.icon).toBe('task');
    expect(entries[0]?.icon).toBe('window');
    expect(guestMessageActionsFor(entries, 'user').map((entry) => entry.action.id)).toEqual(['m-any']);
    expect(guestMessageActionsFor(entries, 'assistant').map((entry) => entry.action.id)).toEqual(['m-any', 'm-assistant']);
    expect(guestSessionActions(entries).map((entry) => entry.action.id)).toEqual(['s']);
  });
});

describe('buildGuestMessageItem', () => {
  test('carries the export text, capped, with the trimmed session title', () => {
    const item = buildGuestMessageItem('create-task', session, record('m1', 'assistant', 'x'.repeat(GUEST_ITEM_MESSAGE_TEXT_MAX + 10)));
    expect(item).toMatchObject({ kind: 'message', action: 'create-task', sessionId: 'ses-1', sessionTitle: 'Hello', directory: '/repo', messageId: 'm1', role: 'assistant' });
    expect(item.text.length).toBe(GUEST_ITEM_MESSAGE_TEXT_MAX);
    expect(buildGuestMessageItem('a', { ...session, sessionTitle: null, directory: null }, record('m1', 'user', 'hi'))).toMatchObject({ sessionTitle: 'ses-1', directory: null, text: 'hi' });
  });
});

describe('buildGuestSessionItem', () => {
  test('omits messages when none were asked for and keeps an empty conversation empty', () => {
    expect(buildGuestSessionItem('summarize', session)).toEqual({
      kind: 'session', action: 'summarize', sessionId: 'ses-1', sessionTitle: 'Hello', directory: '/repo',
    });
    expect(buildGuestSessionItem('summarize', session, []).messages).toEqual([]);
  });

  test('maps records oldest first and skips messages without text', () => {
    const item = buildGuestSessionItem('summarize', session, [
      record('m1', 'user', 'Hi', 10),
      record('m2', 'assistant', '', 20),
      record('m3', 'assistant', 'Hello back', 30),
    ]);
    expect(item.messages).toEqual([
      { id: 'm1', role: 'user', text: 'Hi', createdAt: 10 },
      { id: 'm3', role: 'assistant', text: 'Hello back', createdAt: 30 },
    ]);
    expect(item.truncated).toBeUndefined();
  });

  test('drops the oldest messages until the item fits and marks it truncated', () => {
    const big = 'y'.repeat(GUEST_ITEM_MESSAGE_TEXT_MAX);
    const records = Array.from({ length: 12 }, (_, index) => record(`m${index}`, index % 2 ? 'assistant' : 'user', big, index));
    const item = buildGuestSessionItem('summarize', session, records);
    expect(item.truncated).toBe(true);
    expect(JSON.stringify(item).length).toBeLessThanOrEqual(GUEST_ITEM_SESSION_MAX);
    const kept = item.messages ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(12);
    expect(kept[0]?.id).toBe(`m${12 - kept.length}`);
    expect(kept.at(-1)?.id).toBe('m11');
    // One more message would not have fit.
    expect(JSON.stringify({ ...item, messages: [kept[0], ...kept] }).length).toBeGreaterThan(GUEST_ITEM_SESSION_MAX);
  });
});
