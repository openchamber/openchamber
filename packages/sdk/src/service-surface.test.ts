import { describe, expect, test } from 'bun:test';

import { readSurfaceControlNotice, readSurfaceInputBatch } from './service-surface.ts';

describe('readSurfaceInputBatch', () => {
  const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
  const keyBatch = (extra: { keyCode?: number | string }) => JSON.stringify({ events: [{ type: 'key', action: 'down', key: '.', code: 'Period', modifiers, ...extra }] });

  test('keeps the keyCode the viewer browser reported', () => {
    expect(readSurfaceInputBatch(keyBatch({ keyCode: 190 }))?.events).toEqual([{ type: 'key', action: 'down', key: '.', code: 'Period', keyCode: 190, modifiers }]);
  });

  test('reads key events from hosts that send no keyCode', () => {
    expect(readSurfaceInputBatch(keyBatch({}))?.events).toEqual([{ type: 'key', action: 'down', key: '.', code: 'Period', modifiers }]);
  });

  test('refuses a keyCode outside 0 to 255', () => {
    expect(readSurfaceInputBatch(keyBatch({ keyCode: 256 }))).toBeNull();
    expect(readSurfaceInputBatch(keyBatch({ keyCode: 1.5 }))).toBeNull();
    expect(readSurfaceInputBatch(keyBatch({ keyCode: '190' }))).toBeNull();
  });
});

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
