import { describe, expect, test } from 'bun:test';
import { OpencodeRequestError } from '@/lib/opencode/upstreamError';
import { describeSessionActionError } from './sessionActionError';

const t = ((key: string, params?: Record<string, string | number>) => (
  `${key}${params ? ' ' + Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ') : ''}`
)) as unknown as Parameters<typeof describeSessionActionError>[1];

describe('describeSessionActionError', () => {
  test('quotes the OpenCode status, error class and log ref when the server sent one', () => {
    const error = new OpencodeRequestError('session.update failed (500): ...', {
      status: 500,
      name: 'UnknownError',
      message: 'Unexpected server error. Check server logs for details.',
      ref: 'err_07817ddc',
    });

    expect(describeSessionActionError(error, t)).toBe(
      'sessions.sidebar.session.action.upstreamErrorWithRef status=500 name=UnknownError ref=err_07817ddc',
    );
  });

  test('falls back to the upstream message without a ref, and to the plain error otherwise', () => {
    const noRef = new OpencodeRequestError('session.update failed (404): ...', { status: 404, name: 'NotFoundError', message: 'Session not found' });
    expect(describeSessionActionError(noRef, t)).toBe('sessions.sidebar.session.action.upstreamError status=404 message=Session not found');
    expect(describeSessionActionError(new Error('offline'), t)).toBe('offline');
  });
});
