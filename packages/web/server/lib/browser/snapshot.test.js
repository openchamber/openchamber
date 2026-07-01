import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_REF_ATTR,
  buildResolveElementExpr,
  buildSnapshotScript,
  formatRef,
  isStaleRef,
  parseRef,
} from './snapshot.js';

describe('ref helpers', () => {
  it('formats and parses refs', () => {
    expect(formatRef('7', 42)).toBe('e7-42');
    expect(parseRef('e7-42')).toEqual({ epoch: '7', index: 42 });
    expect(parseRef('nonsense')).toBeNull();
    expect(parseRef(undefined)).toBeNull();
  });

  it('flags refs from a different epoch as stale', () => {
    expect(isStaleRef('e7-3', '7')).toBe(false);
    expect(isStaleRef('e7-3', '8')).toBe(true);
    expect(isStaleRef('garbage', '7')).toBe(true);
  });
});

describe('script builders', () => {
  it('embeds the epoch and parses as a valid JS expression', () => {
    const script = buildSnapshotScript({ epoch: '5', maxNodes: 10 });
    expect(script).toContain('"epoch":"5"');
    expect(script).toContain('"maxNodes":10');
    // Constructing a Function only parses; it must not throw on syntax.
    expect(() => new Function(`return ${script};`)).not.toThrow();
  });

  it('builds a ref resolver expression that parses', () => {
    const expr = buildResolveElementExpr('e5-3');
    expect(expr).toContain(SNAPSHOT_REF_ATTR);
    expect(() => new Function(`return ${expr};`)).not.toThrow();
  });
});
