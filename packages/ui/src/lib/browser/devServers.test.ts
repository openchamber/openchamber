import { describe, expect, test } from 'bun:test';

import { mergeDevServerCandidates } from './devServers';

const discovered = [
  { port: 3000, url: 'http://localhost:3000/', command: 'node' },
  { port: 4321, url: 'http://localhost:4321/', command: 'node' },
  { port: 4323, url: 'http://localhost:4323/', command: 'node' },
];

describe('dev server candidates', () => {
  test('takes the announced address, which carries the base path', () => {
    const merged = mergeDevServerCandidates({
      announced: ['http://localhost:4323/__analytics'],
      discovered,
    });
    expect(merged.find((entry) => entry.port === 4323)?.url).toBe('http://localhost:4323/__analytics');
  });

  test('keeps a listening server whose announcement was mangled', () => {
    // A terminal wrapping ".../localhost:3000" mid-port yields port 300, which
    // parses fine and points nowhere.
    const merged = mergeDevServerCandidates({
      announced: ['http://localhost:300'],
      discovered,
    });
    expect(merged.map((entry) => entry.port)).toContain(3000);
    expect(merged.map((entry) => entry.port)).not.toContain(300);
  });

  test('drops an announced address with nothing listening behind it', () => {
    const merged = mergeDevServerCandidates({
      announced: ['http://localhost:9999/app'],
      discovered,
    });
    expect(merged.map((entry) => entry.port)).not.toContain(9999);
  });

  test('lists servers that never announced themselves', () => {
    const merged = mergeDevServerCandidates({ announced: [], discovered });
    expect(merged.map((entry) => entry.port)).toEqual([3000, 4321, 4323]);
    expect(merged.every((entry) => entry.announced === false)).toBe(true);
  });

  test('puts the servers this run announced first', () => {
    const merged = mergeDevServerCandidates({
      announced: ['http://localhost:4323/__analytics'],
      discovered,
    });
    expect(merged[0]?.port).toBe(4323);
  });

  test('falls back to announcements when discovery is unavailable', () => {
    const merged = mergeDevServerCandidates({
      announced: ['http://localhost:4323/__analytics', 'http://localhost:3000'],
      discovered: null,
    });
    expect(merged.map((entry) => entry.port)).toEqual([3000, 4323]);
  });

  test('is empty when neither source has anything', () => {
    expect(mergeDevServerCandidates({ announced: [], discovered: null })).toEqual([]);
    expect(mergeDevServerCandidates({ announced: [], discovered: [] })).toEqual([]);
  });
});
