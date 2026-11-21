import { describe, expect, test } from 'bun:test';

import { claimGuestIdentifier, claimGuestUrl, guestIdentifierPattern, guestLinkRulesOf, guestLinksVersion, type GuestLinkRule } from './links';
import type { InstalledGuest } from './types';

const tasks: GuestLinkRule = {
  guestId: 'tasks',
  action: 'open',
  keys: ['DEMO'],
  urls: {
    origin: 'https://tasks.example.com',
    identifierPattern: '^[A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16}$',
    patterns: [
      { path: '^/tasks/([A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16})(?:/|$)' },
      { path: '^/browse(?:/|$)', query: { name: 'selectedIssue' } },
    ],
    itemTemplate: '/tasks/{id}',
  },
};
const other: GuestLinkRule = { guestId: 'other', action: 'open', keys: ['DEMO', 'OPS'], urls: null };

const guest = (overrides: Partial<InstalledGuest>): InstalledGuest => ({
  id: 'tasks',
  name: 'Tasks',
  icon: 'task',
  capabilities: { requested: ['links'], granted: ['links'] },
  links: { action: 'open', keys: ['DEMO'], urls: null },
  ...overrides,
});

const matches = (text: string): string[] => [...text.matchAll(guestIdentifierPattern([tasks, other])!)].map((match) => match[0]);

describe('guestLinkRulesOf', () => {
  test('only an extension that is on, approved and granted links claims anything', () => {
    expect(guestLinkRulesOf([guest({})]).map((rule) => rule.guestId)).toEqual(['tasks']);
    expect(guestLinkRulesOf([guest({ enabled: false })])).toEqual([]);
    expect(guestLinkRulesOf([guest({ capabilities: { requested: ['links'], granted: [] } })])).toEqual([]);
    expect(guestLinkRulesOf([guest({ links: undefined })])).toEqual([]);
  });
});

describe('guestIdentifierPattern', () => {
  test('finds declared keys as whole words, never inside a word, path, URL or version', () => {
    expect(matches('See DEMO-2, OPS-14 and (DEMO-3).')).toEqual(['DEMO-2', 'OPS-14', 'DEMO-3']);
    expect(matches('UTF-8 a/DEMO-4 x.DEMO-5 DEMO-6-old DEMO-7.5 #DEMO-8 @DEMO-9 xDEMO-10 DEMO-11x DÉMO-12')).toEqual([]);
    expect(matches('DEMO-12345678901234567')).toEqual([]);
    expect(guestIdentifierPattern([{ ...tasks, keys: [] }])).toBeNull();
  });
});

describe('claimGuestIdentifier', () => {
  test('the first extension in catalog order that lists the key claims it, with the link its template names', () => {
    expect(claimGuestIdentifier([tasks, other], 'DEMO-2')).toEqual({ guestId: 'tasks', action: 'open', identifier: 'DEMO-2', url: 'https://tasks.example.com/tasks/DEMO-2' });
    expect(claimGuestIdentifier([other, tasks], 'DEMO-2')).toEqual({ guestId: 'other', action: 'open', identifier: 'DEMO-2' });
    expect(claimGuestIdentifier([tasks, other], 'OPS-1')?.guestId).toBe('other');
    expect(claimGuestIdentifier([tasks], 'HR-1')).toBeNull();
  });

  test('an identifier fills a template only in the shape its {id} takes, and a chip without a link stays text', () => {
    const numbered: GuestLinkRule = { ...tasks, keys: ['SC'], urls: { ...tasks.urls!, identifierPattern: '^\\d{1,16}$', itemTemplate: '/acme/story/{id}' } };
    expect(claimGuestIdentifier([numbered], 'SC-123')).toEqual({ guestId: 'tasks', action: 'open', identifier: 'SC-123' });
    expect(claimGuestIdentifier([{ ...numbered, action: 'attach' }], 'SC-123')).toBeNull();
    expect(claimGuestIdentifier([{ ...tasks, action: 'attach' }], 'DEMO-2')?.url).toBe('https://tasks.example.com/tasks/DEMO-2');
  });
});

describe('claimGuestUrl', () => {
  test('claims an https link on the exact origin and hands on the path and the template\'s own parameter only', () => {
    expect(claimGuestUrl([tasks], 'https://tasks.example.com/tasks/DEMO-1?token=secret#comment')).toEqual({
      guestId: 'tasks', action: 'open', identifier: 'DEMO-1', url: 'https://tasks.example.com/tasks/DEMO-1',
    });
    expect(claimGuestUrl([tasks], 'https://tasks.example.com/browse?code=abc&selectedIssue=DEMO-9')).toEqual({
      guestId: 'tasks', action: 'open', identifier: 'DEMO-9', url: 'https://tasks.example.com/browse?selectedIssue=DEMO-9',
    });
  });

  test('a link longer than a guest item carries stays an ordinary link', () => {
    const long = `https://tasks.example.com/tasks/DEMO-1/${'a'.repeat(2_000)}`;
    expect(claimGuestUrl([tasks], long)).toBeNull();
    expect(claimGuestUrl([tasks], `https://tasks.example.com/tasks/DEMO-1/${'a'.repeat(100)}`)?.identifier).toBe('DEMO-1');
  });

  test('refuses another scheme, host, port, a www spelling, credentials, and a parameter that is not an identifier', () => {
    for (const href of [
      'http://tasks.example.com/tasks/DEMO-1',
      'https://www.tasks.example.com/tasks/DEMO-1',
      'https://tasks.example.com:8443/tasks/DEMO-1',
      'https://evil.example.com/tasks/DEMO-1',
      'https://user:pass@tasks.example.com/tasks/DEMO-1',
      'https://tasks.example.com/browse?selectedIssue=../etc',
      'https://tasks.example.com/other/DEMO-1',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(claimGuestUrl([tasks], href)).toBeNull();
    }
  });
});

describe('guestLinksVersion', () => {
  test('one mark per rules array, a new one when the rules change', () => {
    const first = [tasks];
    expect(guestLinksVersion(first)).toBe(guestLinksVersion(first));
    expect(guestLinksVersion([tasks])).not.toBe(guestLinksVersion(first));
  });
});
