import { describe, expect, it } from 'vitest';

import { toModelModalities } from './model-modalities.js';

describe('model modalities', () => {
  it('maps MIME types by their top-level type', () => {
    expect(toModelModalities(['text', 'image/jpeg', 'image/png', 'audio/wav', 'video/mp4', 'application/pdf', 'text/plain']))
      .toEqual(['text', 'image', 'audio', 'video', 'pdf']);
  });

  it('keeps entries that name no category as written', () => {
    expect(toModelModalities(['pdf', 'IMAGE/PNG', 'application/json', 'font/woff', 'image', 'application/json']))
      .toEqual(['pdf', 'image', 'application/json', 'font/woff']);
    expect(toModelModalities(['embedding'])).toEqual(['embedding']);
    expect(toModelModalities(['  application/json  ', 'image/not a MIME', '   ']))
      .toEqual(['  application/json  ', 'image/not a MIME', '   ']);
  });

  it('reads MIME parameters as part of the type', () => {
    expect(toModelModalities(['application/pdf; version=1.7', 'text/plain;charset=utf-8'])).toEqual(['pdf', 'text']);
  });

  it('keeps an empty list empty', () => {
    expect(toModelModalities([])).toEqual([]);
  });
});
