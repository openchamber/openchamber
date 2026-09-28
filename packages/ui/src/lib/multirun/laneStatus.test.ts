import { describe, expect, test } from 'bun:test';
import { resolveLaneStatus } from './laneStatus';

const ended = { created: 1, updated: 2, idle: 2 };
const neverEnded = { created: 1, updated: 1 };
const answered = { state: 'ready', text: 'Done.', error: null } as const;

describe('resolveLaneStatus', () => {
  test('a blocking request wins over a busy turn', () => {
    expect(resolveLaneStatus({ session: { time: ended }, busy: true, blocking: 'permission', reply: answered })).toBe('permission');
    expect(resolveLaneStatus({ session: { time: ended }, busy: true, blocking: 'question', reply: answered })).toBe('question');
  });

  test('a live turn is working whatever the last outcome was', () => {
    expect(resolveLaneStatus({ session: { outcome: 'failed', time: ended }, busy: true, blocking: null, reply: answered })).toBe('working');
  });

  test('recorded outcomes are not shown as success', () => {
    expect(resolveLaneStatus({ session: { outcome: 'failed', time: ended }, busy: false, blocking: null, reply: answered })).toBe('failed');
    expect(resolveLaneStatus({ session: { outcome: 'interrupted', time: ended }, busy: false, blocking: null, reply: answered })).toBe('stopped');
  });

  test('a lane that never ended a turn has not started', () => {
    expect(resolveLaneStatus({ session: { time: neverEnded }, busy: false, blocking: null, reply: undefined })).toBe('notStarted');
  });

  test('an empty answer is not finished, an unread or failed read still is', () => {
    expect(resolveLaneStatus({ session: { outcome: 'succeeded', time: ended }, busy: false, blocking: null, reply: { state: 'ready', text: '', error: null } })).toBe('noReply');
    expect(resolveLaneStatus({ session: { outcome: 'succeeded', time: ended }, busy: false, blocking: null, reply: answered })).toBe('finished');
    expect(resolveLaneStatus({ session: { time: ended }, busy: false, blocking: null, reply: { state: 'error' } })).toBe('finished');
    expect(resolveLaneStatus({ session: { time: ended }, busy: false, blocking: null, reply: { state: 'loading' } })).toBe('finished');
  });
});
