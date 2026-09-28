import { describe, expect, test } from 'bun:test';

import { shouldShowFileCanvas } from './fileCanvas';

describe('shouldShowFileCanvas', () => {
  const shown = (overrides: Partial<Parameters<typeof shouldShowFileCanvas>[0]>) =>
    shouldShowFileCanvas({ hasCanvas: true, viewMode: 'preview', previewReady: true, mountable: true, ...overrides });

  test('mounts a canvas that can open the draft, in preview, once the file loaded', () => {
    expect(shown({})).toBe(true);
  });

  test('never mounts over a draft the canvas cannot take, so a blank document cannot be saved over it', () => {
    expect(shown({ mountable: false })).toBe(false);
  });

  test('stays off in source mode, before the file finished loading, and for files without a canvas', () => {
    expect(shown({ viewMode: 'edit' })).toBe(false);
    expect(shown({ previewReady: false })).toBe(false);
    expect(shown({ hasCanvas: false })).toBe(false);
  });
});
