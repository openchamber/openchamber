import { describe, expect, test } from 'bun:test';
import { GUEST_ITEM_MESSAGE_TEXT_MAX, GUEST_ITEM_SESSION_MAX } from '@openchamber/sdk';
import type { Message, Part, SyntheticMessage } from '@/lib/opencode/model';

import {
  buildGuestMessageItem,
  buildGuestSessionItem,
  guestActionEntries,
  guestMessageActionsFor,
  guestSessionActions,
} from './actions.ts';
import type { InstalledGuest } from './types.ts';
import { enabledGuestSurfaces } from './surfaces.ts';
import { parseGuestCatalogJson } from './parse.ts';

const assistant = (id: string, created: number): Message => ({
  id, role: 'assistant', sessionID: 'ses-1', time: { created },
  agent: 'build', providerID: 'anthropic', modelID: 'sonnet',
});

const record = (id: string, role: 'user' | 'assistant', text: string, created = 1) => ({
  info: role === 'user'
    ? { id, role, sessionID: 'ses-1', time: { created } }
    : assistant(id, created),
  parts: [{ id: `${id}-p`, sessionID: 'ses-1', messageID: id, type: 'text' as const, text } satisfies Part],
});

const NO_PARTS: readonly Part[] = [];

/** A plumbing role v2 interleaves with the conversation; it carries no parts. */
const plumbing = (id: string, created: number) => ({
  info: { id, role: 'system' as const, sessionID: 'ses-1', time: { created }, text: 'instructions changed' },
  parts: [...NO_PARTS],
});

/** Context the user attached — v2 delivers it as its own synthetic message. */
const attachedContext = (id: string, created: number) => {
  const info: SyntheticMessage = {
    id, role: 'synthetic', sessionID: 'ses-1', time: { created },
    text: 'Quoted from a.ts',
    metadata: {
      openchamberContext: {
        kind: 'file-quote', fileLabel: 'a.ts', quote: 'const a = 1;', text: 'look at this',
      },
    },
  };
  return { info, parts: [...NO_PARTS] };
};

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
  test('background-only guests keep actions through catalog parsing without a rail surface', () => {
    const background = guest('background', { entry: undefined, backgroundEntry: 'background/index.html', actions: [
      { id: 'count', label: 'Count', where: 'message', mode: 'background' },
    ] });
    const catalog = parseGuestCatalogJson(JSON.stringify({ guests: [background] }));
    if (!catalog) throw new Error('Expected a valid catalog');
    expect(catalog[0].backgroundEntry).toBe('background/index.html');
    expect(guestActionEntries(catalog, (path) => path).map((entry) => entry.action.id)).toEqual(['count']);
    expect(enabledGuestSurfaces(catalog, (path) => path)).toEqual([]);
    expect(guestActionEntries([{ ...background, enabled: false }], (path) => path)).toEqual([]);
    expect(guestActionEntries([{ ...background, actions: [{ id: 'open', label: 'Open', where: 'message' }] }], (path) => path)).toEqual([]);
  });

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

  test('keeps attached context on the user side and drops plumbing roles', () => {
    const item = buildGuestSessionItem('summarize', session, [
      attachedContext('c1', 5),
      plumbing('s1', 6),
      record('m1', 'user', 'Hi', 10),
    ]);
    expect(item.messages?.map((message) => ({ id: message.id, role: message.role }))).toEqual([
      { id: 'c1', role: 'user' },
      { id: 'm1', role: 'user' },
    ]);
    expect(item.messages?.[0].text).toContain('const a = 1;');
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
