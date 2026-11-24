import { expect, test } from 'bun:test';
import { findNestedSessionCandidates, NestedSessionOwnerDiscovery, readNestedWorktreePaths, type NestedSessionOwnerCandidate } from './readOnlySessionAssociation';

const projects = [{ id: 'outer', path: '/projects' }, { id: 'inner', path: '/projects/service' }];
const native = [{ id: 'hash', worktree: '/projects/service/repo', vcs: 'git' }];
const root = (id: string, directory: string) => ({ id, directory, projectID: 'hash' });

test('the containing project lists only active root sessions in Git-confirmed linked checkouts', async () => {
  const candidates = findNestedSessionCandidates([
    root('target', '/trees/target'), root('clone', '/trees/clone'), root('removed', '/trees/prunable'),
    root('explicit', '/configured'), root('normal', '/known-tree'),
    { ...root('child', '/trees/target'), parentID: 'parent' },
    { ...root('archived', '/trees/target'), time: { archived: 1 } },
  ], [...projects, { id: 'direct', path: '/configured' }], native, new Set(['/known-tree']));
  const repo = native[0]!.worktree;
  const linked = await readNestedWorktreePaths(repo, async () => [
    { path: repo }, { path: '/trees/target' }, { path: '/trees/prunable', prunable: true }, { path: '/configured' }, { path: '/known-tree' },
  ]);
  const discovery = new NestedSessionOwnerDiscovery(async () => linked, () => {});
  discovery.reconcile(candidates);
  await flush();
  const result = discovery.owners(candidates);
  expect([...result]).toEqual([['target', { projectId: 'inner', projectRoot: '/projects/service', directory: '/trees/target' }]]);
});

test('a session started below a linked checkout root belongs to that checkout; a sibling prefix does not', async () => {
  const below = { ...candidate('below', '/repo'), directory: '/trees/feature/packages/app' };
  const sibling = { ...candidate('sibling', '/repo'), directory: '/trees/feature-2' };
  const discovery = new NestedSessionOwnerDiscovery(async () => new Set(['/trees/feature']), () => {});
  discovery.reconcile([below, sibling]);
  await flush();
  expect([...discovery.owners([below, sibling])]).toEqual([
    ['below', { projectId: 'outer', projectRoot: '/projects', directory: '/trees/feature/packages/app' }],
  ]);
});

test('a sibling prefix, configured repo, conflicting project identity or failed Git read grants no association', async () => {
  const input = [root('s', '/external')];
  const candidates = (canonical: typeof native, folders = projects) =>
    findNestedSessionCandidates(input, folders, canonical, new Set());
  expect(candidates([{ ...native[0]!, worktree: '/projects/services/repo' }], [projects[1]!])).toHaveLength(0);
  // A Git project folder holds a nested repository (a submodule) just like a plain folder does.
  expect(candidates([{ ...native[0]!, worktree: '/projects/services/repo' }])[0]?.projectId).toBe('outer');
  expect(candidates(native, [{ id: 'same', path: native[0]!.worktree }])).toHaveLength(0);
  expect(candidates([...native, { ...native[0]!, worktree: '/clone' }])).toHaveLength(0);
  const repo = native[0]!.worktree;
  const absent = await readNestedWorktreePaths(repo, async () => [{ path: '/moved-primary' }, { path: '/external' }]);
  expect(absent).toEqual(new Set());
  await expect(readNestedWorktreePaths(repo, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
});

const candidate = (id: string, repository: string): NestedSessionOwnerCandidate => ({
  id, repository, projectId: 'outer', projectRoot: '/projects', directory: `/trees/${id}`,
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('lists each newly seen repository once and retains settled reads across candidate snapshots', async () => {
  const calls: string[] = [];
  const discovery = new NestedSessionOwnerDiscovery(async (repository) => {
    calls.push(repository);
    return new Set([`/trees/repo-${repository.slice(-1)}`]);
  }, () => {});
  const initial = Array.from({ length: 5 }, (_, index) => candidate(`repo-${index}`, `/repo/${index}`));

  discovery.reconcile(initial);
  await flush();
  expect(calls).toEqual(['/repo/0', '/repo/1', '/repo/2', '/repo/3', '/repo/4']);
  const sameCheckout = { ...initial[0]!, id: 'another-conversation' };
  discovery.reconcile([...initial, sameCheckout]);
  expect(discovery.owners([sameCheckout]).has(sameCheckout.id)).toBe(true);
  expect(calls).toHaveLength(5);
  discovery.reconcile([...initial, candidate('later', '/repo/0')]);
  discovery.reconcile(initial);
  await flush();

  expect(calls).toEqual(['/repo/0', '/repo/1', '/repo/2', '/repo/3', '/repo/4', '/repo/0']);
  expect(discovery.owners(initial).size).toBe(5);
  expect(discovery.owners([candidate('later', '/repo/0')]).size).toBe(0);
});

test('a session created in a new linked checkout triggers a read of its repository without a topology event', async () => {
  const first = candidate('first', '/repo'), second = candidate('second', '/repo');
  const paths = new Set([first.directory]);
  const discovery = new NestedSessionOwnerDiscovery(async () => new Set(paths), () => {});
  discovery.reconcile([first]); await flush();
  paths.add(second.directory);
  discovery.reconcile([first, second]); await flush();
  expect([...discovery.owners([first, second]).keys()]).toEqual(['first', 'second']);
});

test('retries a failed lookup on a later snapshot and invalidation replaces proof only after completion', async () => {
  let reads = 0;
  let resolveRefresh!: (value: ReadonlySet<string> | null) => void;
  const discovery = new NestedSessionOwnerDiscovery(async () => {
    reads += 1;
    if (reads === 1) throw new Error('offline');
    if (reads === 2) return new Set(['/trees/session']);
    return new Promise((resolve) => { resolveRefresh = resolve; });
  }, () => {});
  const item = candidate('session', '/repo');

  discovery.reconcile([item]);
  await flush();
  expect(discovery.owners([item]).size).toBe(0);
  discovery.reconcile([item]);
  await flush();
  expect(discovery.owners([item]).get('session')?.directory).toBe('/trees/session');

  discovery.invalidate(new Set(['/repo']), [item]);
  expect(discovery.owners([item]).get('session')?.directory).toBe('/trees/session');
  resolveRefresh(new Set());
  await flush();
  expect(discovery.owners([item]).size).toBe(0);
  expect(reads).toBe(3);
});

test('a removed repository ignores its late result', async () => {
  let resolveRead!: (value: ReadonlySet<string> | null) => void;
  const discovery = new NestedSessionOwnerDiscovery(() => new Promise((resolve) => { resolveRead = resolve; }), () => {});
  const item = candidate('session', '/repo');

  discovery.reconcile([item]);
  discovery.reconcile([]);
  resolveRead(new Set(['/trees/session']));
  await flush();

  expect(discovery.owners([item]).size).toBe(0);
});

test('an unlisted session arriving during a Git read gets a single follow-up read', async () => {
  const a = candidate('a', '/repo'), b = candidate('b', '/repo');
  let reads = 0;
  let finish!: (paths: ReadonlySet<string>) => void;
  const discovery = new NestedSessionOwnerDiscovery(() => ++reads === 1
    ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(new Set([a.directory, b.directory])), () => {});
  discovery.reconcile([a]);
  discovery.reconcile([a, b]);
  finish(new Set([a.directory])); await flush(); await flush();
  expect([...discovery.owners([a, b]).keys()]).toEqual(['a', 'b']);
  expect(reads).toBe(2);
});

test('a rejected refresh cannot authorize access using the old checkout list', async () => {
  const target = candidate('target', '/repo');
  let available = true;
  const discovery = new NestedSessionOwnerDiscovery(async () => {
    if (!available) throw new Error('Git unavailable');
    return new Set([target.directory]);
  }, () => {});
  discovery.reconcile([target]); await flush();
  available = false; discovery.invalidate(new Set(['/repo']), [target]); await flush();
  expect(discovery.owners([target]).size).toBe(0);
  available = true; discovery.reconcile([target]); await flush();
  expect(discovery.owners([target]).has(target.id)).toBe(true);
});
