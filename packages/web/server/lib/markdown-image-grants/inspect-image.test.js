import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { inspectLocalImage } from './inspect-image.js';

const inspectWithFailure = (error) => inspectLocalImage({
  source: 'image.png',
  directory: path.resolve('workspace'),
  fsPromises: {
    realpath: vi.fn().mockRejectedValue(error),
    open: vi.fn(),
  },
  path,
});

describe('local image inspection failures', () => {
  it.each([
    ['ENOENT', 'missing'],
    ['EACCES', 'error'],
    ['EPERM', 'error'],
    ['ELOOP', 'error'],
  ])('returns %s as %s', async (code, status) => {
    const error = Object.assign(new Error('File unavailable'), { code });
    await expect(inspectWithFailure(error)).resolves.toEqual({ status });
  });

  it.each([
    new Error('Unexpected failure'),
    Object.assign(new Error('I/O failure'), { code: 'EIO' }),
    null,
    undefined,
    'failure',
    42,
  ])('propagates an unrecognized failure unchanged: %s', async (error) => {
    await expect(inspectWithFailure(error)).rejects.toBe(error);
  });
});
