import { describe, expect, it } from 'vitest';

import {
  hasFileIdentity,
  sameFileObjectIdentity,
  sameFileIdentity,
  snapshotFileIdentity,
} from './file-identity.js';

const fileStat = (overrides = {}) => ({
  dev: 7,
  ino: 11,
  type: 'file',
  birthtimeMs: 100,
  ctimeMs: 200,
  ...overrides,
});

describe('file identity', () => {
  it('does not compare one snapshot birthtime against the other snapshot ctime', () => {
    const withBirthtime = fileStat();
    const ctimeOnly = fileStat({ birthtimeMs: undefined });

    expect(snapshotFileIdentity(withBirthtime)).toMatchObject({
      birthtime: 'ms:100',
      ctime: 'ms:200',
    });
    expect(snapshotFileIdentity(ctimeOnly)).toMatchObject({
      birthtime: null,
      ctime: 'ms:200',
    });
    expect(sameFileIdentity(withBirthtime, ctimeOnly)).toBe(false);
  });

  it('uses ctime only when both snapshots lack birthtime', () => {
    expect(sameFileIdentity(
      fileStat({ birthtimeMs: undefined }),
      fileStat({ birthtimeMs: undefined }),
    )).toBe(true);
  });

  it('only ignores a ctime transition for an explicitly descriptor-proven object', () => {
    const beforeQuarantine = fileStat({ birthtimeMs: undefined, ctimeMs: 200 });
    const afterQuarantine = fileStat({ birthtimeMs: undefined, ctimeMs: 201 });

    expect(sameFileIdentity(beforeQuarantine, afterQuarantine)).toBe(false);
    expect(sameFileObjectIdentity(beforeQuarantine, afterQuarantine)).toBe(true);
  });

  it('fails closed when required identity metadata is missing', () => {
    expect(hasFileIdentity(fileStat({ dev: undefined }))).toBe(false);
    expect(hasFileIdentity(fileStat({ ino: undefined }))).toBe(false);
    expect(hasFileIdentity(fileStat({ type: undefined }))).toBe(false);
    expect(hasFileIdentity(fileStat({ birthtimeMs: undefined, ctimeMs: undefined }))).toBe(false);
    expect(sameFileIdentity(
      fileStat(),
      fileStat({ birthtimeMs: undefined, ctimeMs: undefined }),
    )).toBe(false);
  });
});
