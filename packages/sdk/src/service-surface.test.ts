import { describe, expect, test } from 'bun:test';

import { readSurfaceControlNotice } from './service-surface.ts';

describe('readSurfaceControlNotice', () => {
  test('keeps the controlling viewer for a user controller', () => {
    expect(readSurfaceControlNotice('{"controller":"user","viewer":"viewer-1"}')).toEqual({ controller: 'user', viewer: 'viewer-1' });
  });

  test('reads notices from hosts that send no viewer', () => {
    expect(readSurfaceControlNotice('{"controller":"user"}')).toEqual({ controller: 'user' });
  });

  test('drops a viewer attached to a non-user controller', () => {
    expect(readSurfaceControlNotice('{"controller":"agent","viewer":"viewer-1"}')).toEqual({ controller: 'agent' });
  });

  test('refuses an unknown controller', () => {
    expect(readSurfaceControlNotice('{"controller":"robot"}')).toBeNull();
  });
});
