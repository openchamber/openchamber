import { describe, expect, it } from 'vitest';

import { resolveByteRange } from './byte-range.js';

describe('resolveByteRange', () => {
  it('serves the whole file without a header, for an empty file, and for anything but one bytes span', () => {
    expect(resolveByteRange(undefined, 100)).toEqual({ kind: 'whole' });
    expect(resolveByteRange('bytes=0-', 0)).toEqual({ kind: 'whole' });
    expect(resolveByteRange('items=0-1', 100)).toEqual({ kind: 'whole' });
    expect(resolveByteRange('bytes=0-1,5-9', 100)).toEqual({ kind: 'whole' });
    expect(resolveByteRange('bytes=-', 100)).toEqual({ kind: 'whole' });
  });

  it('answers the open-ended span a media element sends on seek', () => {
    expect(resolveByteRange('bytes=0-', 100)).toEqual({ kind: 'range', start: 0, end: 99 });
    expect(resolveByteRange('bytes=40-', 100)).toEqual({ kind: 'range', start: 40, end: 99 });
  });

  it('clamps a closed span to the file and honours a suffix span', () => {
    expect(resolveByteRange('bytes=10-19', 100)).toEqual({ kind: 'range', start: 10, end: 19 });
    expect(resolveByteRange('bytes=90-500', 100)).toEqual({ kind: 'range', start: 90, end: 99 });
    expect(resolveByteRange('bytes=-30', 100)).toEqual({ kind: 'range', start: 70, end: 99 });
    expect(resolveByteRange('bytes=-300', 100)).toEqual({ kind: 'range', start: 0, end: 99 });
  });

  it('rejects a span that starts past the end or runs backwards', () => {
    expect(resolveByteRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveByteRange('bytes=50-40', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveByteRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
  });
});
