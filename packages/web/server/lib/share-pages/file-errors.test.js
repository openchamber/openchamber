import { describe, expect, it } from 'vitest';

import { isMissingFileError } from './file-errors.js';

describe('missing file errors', () => {
  it.each([
    { code: 'ENOENT' },
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
    Object.create({ code: 'ENOENT' }),
    Object.assign(() => {}, { code: 'ENOENT' }),
  ])('recognizes the missing-file code on a thrown value', (error) => {
    expect(isMissingFileError(error)).toBe(true);
  });

  it.each([null, undefined, 'ENOENT', 0, false, {}, { code: 'EACCES' }])('leaves other failures unrecognized', (error) => {
    expect(isMissingFileError(error)).toBe(false);
  });
});
