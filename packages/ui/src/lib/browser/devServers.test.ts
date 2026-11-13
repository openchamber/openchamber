import { describe, expect, test } from 'bun:test';

import { mergeDevServerCandidates, placeDevServerCandidates } from './devServers';

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

  test('keeps the folder a server runs in', () => {
    const merged = mergeDevServerCandidates({
      announced: [],
      discovered: [{ port: 3000, url: 'http://localhost:3000/', command: 'node', directory: '/work/site' }],
    });
    expect(merged[0]?.directory).toBe('/work/site');
  });
});

describe('placing dev servers', () => {
  const folders = [
    { path: '/work/app', projectPath: '/work/app' },
    { path: '/wt/app/feature', projectPath: '/work/app' },
    { path: '/work/site', projectPath: '/work/site' },
  ];
  const server = (port: number, directory?: string, announced = false) => ({
    port,
    url: `http://localhost:${port}/`,
    announced,
    directory,
  });
  const place = (candidates: ReturnType<typeof server>[], directory = '/wt/app/feature') => (
    placeDevServerCandidates({ candidates, folders, directory })
  );

  test('names the project or worktree folder, even from a subfolder', () => {
    const [placed] = place([server(5173, '/wt/app/feature/packages/web')]);
    expect(placed?.folderName).toBe('feature');
    expect(placed?.outsideWork).toBe(false);
  });

  test('marks servers started outside every project', () => {
    const placed = place([server(5000, '/'), server(55569, '/Users/me')]);
    expect(placed.map((entry) => entry.outsideWork)).toEqual([true, true]);
    expect(placed.map((entry) => entry.folderName)).toEqual([null, null]);
  });

  test('keeps a server whose folder is unknown, as on Windows', () => {
    const [placed] = place([server(3000)]);
    expect(placed?.outsideWork).toBe(false);
  });

  test('keeps a server that announced itself wherever it runs', () => {
    const [placed] = place([server(8080, '/tmp/elsewhere', true)]);
    expect(placed?.outsideWork).toBe(false);
  });

  test('does not take a sibling folder with a shared prefix for a project', () => {
    const [placed] = place([server(3000, '/work/application')]);
    expect(placed?.outsideWork).toBe(true);
  });

  test('orders the panel folder first, then its project, then the rest by port', () => {
    const placed = place([
      server(3000, '/work/site'),
      server(4000),
      server(5000, '/work/app'),
      server(6000, '/wt/app/feature'),
      server(7000, '/elsewhere', true),
    ]);
    expect(placed.map((entry) => entry.port)).toEqual([7000, 6000, 5000, 3000, 4000]);
  });

  test('counts the panel folder as a work folder when no list knows it', () => {
    const [placed] = placeDevServerCandidates({
      candidates: [server(5173, '/scratch/new-thing')],
      folders,
      directory: '/scratch/new-thing',
    });
    expect(placed?.outsideWork).toBe(false);
  });
});
