import { describe, expect, test } from 'vitest';

import { SERVICE_MARKS_MAX } from '@openchamber/sdk';

import { createGuestMarks, mayGuestShowMarks } from './marks.js';

const failed = { icon: 'close-circle', tone: 'error', text: '2 tests failed' };
const passed = { icon: 'checkbox-circle', tone: 'success', text: 'All tests passed' };

/** A service host where `live` names the token each guest's running process holds. */
const harness = (live = { desk: 'token-1' }) => {
  const marks = createGuestMarks({
    guestIdOfToken: (token) => Object.keys(live).find((guestId) => live[guestId] === token) ?? null,
  });
  return { marks, live };
};

describe('guest marks', () => {
  test('one mark per target, replaced by the next and removed by null', () => {
    const { marks } = harness();
    expect(marks.set('desk', 'token-1', { sessionId: 'ses_1' }, failed)).toBe('changed');
    expect(marks.set('desk', 'token-1', { sessionId: 'ses_1' }, passed)).toBe('changed');
    expect(marks.set('desk', 'token-1', { directory: '/repo', branch: 'main' }, failed)).toBe('changed');
    expect(marks.set('desk', 'token-1', { directory: '/repo' }, failed)).toBe('changed');
    expect(marks.list('desk')).toEqual([
      { target: { sessionId: 'ses_1' }, mark: passed },
      { target: { directory: '/repo', branch: 'main' }, mark: failed },
      { target: { directory: '/repo' }, mark: failed },
    ]);
    expect(marks.set('desk', 'token-1', { sessionId: 'ses_1' }, null)).toBe('changed');
    expect(marks.set('desk', 'token-1', { directory: '/repo', branch: 'main' }, null)).toBe('changed');
    expect(marks.list('desk')).toEqual([{ target: { directory: '/repo' }, mark: failed }]);
  });

  test('a set that changes nothing says so', () => {
    const { marks } = harness();
    marks.set('desk', 'token-1', { sessionId: 'ses_1' }, { ...failed, url: 'https://ci.example/7' });
    expect(marks.set('desk', 'token-1', { sessionId: 'ses_1' }, { url: 'https://ci.example/7', text: failed.text, tone: failed.tone, icon: failed.icon })).toBe('unchanged');
    expect(marks.set('desk', 'token-1', { sessionId: 'ses_1' }, failed)).toBe('changed');
    expect(marks.set('desk', 'token-1', { sessionId: 'ses_2' }, null)).toBe('unchanged');
    expect(marks.set('desk', 'token-1', { directory: '/repo', branch: 'main' }, null)).toBe('unchanged');
  });

  test('a session id, a folder and a branch that spell alike are three targets', () => {
    const { marks } = harness();
    marks.set('desk', 'token-1', { sessionId: '/repo' }, failed);
    marks.set('desk', 'token-1', { directory: '/repo' }, failed);
    marks.set('desk', 'token-1', { directory: '/repo', branch: '/repo' }, failed);
    marks.set('desk', 'token-1', { directory: '/re', branch: 'po' }, failed);
    expect(marks.list('desk')).toHaveLength(4);
  });

  test('holds a bounded number, and a full guest may still replace and remove', () => {
    const { marks } = harness();
    for (let index = 0; index < SERVICE_MARKS_MAX; index += 1) {
      expect(marks.set('desk', 'token-1', { sessionId: `ses_${index}` }, failed)).toBe('changed');
    }
    expect(marks.set('desk', 'token-1', { sessionId: 'one-more' }, failed)).toBe('full');
    expect(marks.list('desk')).toHaveLength(SERVICE_MARKS_MAX);
    expect(marks.set('desk', 'token-1', { sessionId: 'ses_0' }, passed)).toBe('changed');
    expect(marks.set('desk', 'token-1', { sessionId: 'ses_1' }, null)).toBe('changed');
    expect(marks.set('desk', 'token-1', { sessionId: 'one-more' }, failed)).toBe('changed');
  });

  test('asks whether it may change only when it would, and changes nothing on a no', () => {
    const { marks } = harness();
    let asked = 0;
    const no = () => {
      asked += 1;
      return false;
    };
    marks.set('desk', 'token-1', { sessionId: 'ses_1' }, failed);
    expect(marks.set('desk', 'token-1', { sessionId: 'ses_1' }, failed, no)).toBe('unchanged');
    expect(marks.set('desk', 'token-1', { sessionId: 'ses_2' }, null, no)).toBe('unchanged');
    expect(marks.set('desk', 'stale', { sessionId: 'ses_2' }, failed, no)).toBe('ended');
    expect(asked).toBe(0);
    expect(marks.set('desk', 'token-1', { sessionId: 'ses_1' }, passed, no)).toBe('limited');
    expect(marks.set('desk', 'token-1', { sessionId: 'ses_2' }, failed, no)).toBe('limited');
    expect(marks.set('desk', 'token-1', { sessionId: 'ses_1' }, null, no)).toBe('limited');
    expect(asked).toBe(3);
    expect(marks.list('desk')).toEqual([{ target: { sessionId: 'ses_1' }, mark: failed }]);
  });

  test('a full guest is told so without spending a change', () => {
    const { marks } = harness();
    for (let index = 0; index < SERVICE_MARKS_MAX; index += 1) marks.set('desk', 'token-1', { sessionId: `ses_${index}` }, failed);
    let asked = 0;
    expect(marks.set('desk', 'token-1', { sessionId: 'one-more' }, failed, () => { asked += 1; return true; })).toBe('full');
    expect(asked).toBe(0);
  });

  test('refuses a token that does not name the guest', () => {
    const { marks } = harness({ desk: 'token-1', other: 'token-2' });
    expect(marks.set('desk', 'stale', { sessionId: 'ses_1' }, failed)).toBe('ended');
    expect(marks.set('desk', 'token-2', { sessionId: 'ses_1' }, failed)).toBe('ended');
    expect(marks.list('desk')).toEqual([]);
    expect(marks.list('other')).toEqual([]);
  });

  test('marks are gone with the process that set them, without anyone clearing them', () => {
    const { marks, live } = harness();
    marks.set('desk', 'token-1', { sessionId: 'ses_1' }, failed);
    delete live.desk;
    expect(marks.list('desk')).toEqual([]);
    // The same token never comes back to life with its marks.
    live.desk = 'token-1';
    expect(marks.list('desk')).toEqual([]);
  });

  test('the next process starts with none', () => {
    const { marks, live } = harness();
    marks.set('desk', 'token-1', { sessionId: 'ses_1' }, failed);
    live.desk = 'token-2';
    expect(marks.list('desk')).toEqual([]);
    expect(marks.set('desk', 'token-2', { sessionId: 'ses_2' }, passed)).toBe('changed');
    expect(marks.list('desk')).toEqual([{ target: { sessionId: 'ses_2' }, mark: passed }]);
    expect(marks.set('desk', 'token-1', { sessionId: 'ses_1' }, failed)).toBe('ended');
  });

  test('dropEnded says whether an ended process left marks, and leaves a running one alone', () => {
    const { marks, live } = harness();
    expect(marks.dropEnded('desk')).toBe(false);
    marks.set('desk', 'token-1', { sessionId: 'ses_1' }, failed);
    expect(marks.dropEnded('desk')).toBe(false);
    expect(marks.list('desk')).toHaveLength(1);
    // A newer process already holds the guest by the time the old one is reported ended.
    live.desk = 'token-2';
    marks.set('desk', 'token-2', { sessionId: 'ses_2' }, passed);
    expect(marks.dropEnded('desk')).toBe(false);
    expect(marks.list('desk')).toEqual([{ target: { sessionId: 'ses_2' }, mark: passed }]);
    delete live.desk;
    expect(marks.dropEnded('desk')).toBe(true);
    expect(marks.dropEnded('desk')).toBe(false);
  });

  test('clearGuest drops one guest and says whether it held any', () => {
    const { marks } = harness({ desk: 'token-1', other: 'token-2' });
    marks.set('desk', 'token-1', { sessionId: 'ses_1' }, failed);
    marks.set('other', 'token-2', { sessionId: 'ses_1' }, passed);
    expect(marks.clearGuest('desk')).toBe(true);
    expect(marks.clearGuest('desk')).toBe(false);
    expect(marks.list('desk')).toEqual([]);
    expect(marks.list('other')).toEqual([{ target: { sessionId: 'ses_1' }, mark: passed }]);
  });
});

describe('mayGuestShowMarks', () => {
  const guest = (overrides = {}) => ({
    id: 'desk',
    enabled: true,
    service: { entry: 'service/main.js', runtime: 'host' },
    marks: true,
    capabilityGrants: ['service', 'marks'],
    ...overrides,
  });

  test('an extension that is on, approved and asks for marks', () => {
    expect(mayGuestShowMarks(guest())).toBe(true);
  });

  test('not a paused one, an unapproved one, or one with only part of what it asks approved', () => {
    expect(mayGuestShowMarks(guest({ enabled: false }))).toBe(false);
    expect(mayGuestShowMarks(guest({ capabilityGrants: [] }))).toBe(false);
    expect(mayGuestShowMarks(guest({ capabilityGrants: undefined }))).toBe(false);
    expect(mayGuestShowMarks(guest({ capabilityGrants: ['marks'] }))).toBe(false);
    expect(mayGuestShowMarks(guest({ capabilityGrants: ['service'] }))).toBe(false);
    expect(mayGuestShowMarks(guest({ instructions: true }))).toBe(false);
  });

  test('not one whose manifest stopped asking, whatever grant it kept', () => {
    expect(mayGuestShowMarks(guest({ marks: undefined }))).toBe(false);
  });
});
