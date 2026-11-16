import { describe, expect, test } from 'bun:test';
import { IMAGE_JOB_LIFETIME_MS, readImageJobEnd, readImageJobStart, runningImageJobFromWire } from './background-image';

const wire = (started: number) => ({ kind: 'image', id: 'image_1', sessionID: 'ses_1', status: 'running', path: '/tmp/a', model: 'p/m', time: { started } });

describe('background image jobs', () => {
  test('reads the job a settled call started, and nothing from other calls', () => {
    expect(readImageJobStart({ jobID: 'image_1', path: '/tmp/a', model: 'p/m' })).toEqual({ id: 'image_1', path: '/tmp/a', model: 'p/m' });
    expect(readImageJobStart({ status: 'running', shellID: 'sh_1' })).toBeUndefined();
  });

  test('reads the end from the notice under either tool name', () => {
    const notice = (source: string) => ({ id: 'm', sessionID: 's', role: 'synthetic' as const, text: '', time: { created: 1 }, metadata: { source, jobID: 'image_1' } });
    expect(readImageJobEnd(notice('experimental_image_generate'))).toBe('image_1');
    expect(readImageJobEnd(notice('image_generate'))).toBe('image_1');
    expect(readImageJobEnd(notice('shell'))).toBeUndefined();
  });

  test('a listed job past the image timeout counts as gone', () => {
    const now = 100 * IMAGE_JOB_LIFETIME_MS;
    expect(runningImageJobFromWire(wire(now - 1000), now)?.id).toBe('image_1');
    expect(runningImageJobFromWire(wire(now - IMAGE_JOB_LIFETIME_MS - 1), now)).toBeNull();
  });
});
