import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { RepositoryReferenceFilter, SourceControlBindingRead } from '@/lib/api/types';
import { projectOfBinding } from './repositoryProject';
import {
  rememberRepositoryFilter,
  repositoryFilterKey,
  savedRepositoryFilter,
} from './repositoryFilterMemory';

const STORAGE_KEY = 'openchamber.repositoryFilters.v1';
const store = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
};
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, 'window', { value: { localStorage: fakeStorage }, configurable: true });
});
afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

const keyOf = (repo: string, kind: 'issue' | 'pull' = 'issue', owner = 'acme') => repositoryFilterKey(
  'github',
  'github.com',
  { owner, repo },
  kind,
);

const filter = (patch: Partial<RepositoryReferenceFilter> = {}): RepositoryReferenceFilter => ({
  state: 'open',
  people: 'any',
  labels: [],
  ...patch,
});

const binding = (owner: string, name: string, remoteUrl: string): SourceControlBindingRead => ({
  status: 'bound',
  revision: 1,
  repository: {
    repositoryId: 'repo-1',
    configRevision: 'rev',
    bare: false,
    remotes: [{
      name: 'origin',
      fetch: { displayUrl: remoteUrl, fingerprint: 'origin-fetch' },
      push: { displayUrl: remoteUrl, fingerprint: 'origin-push' },
    }],
  },
  binding: {
    repositoryId: 'repo-1',
    configRevision: 'rev',
    revision: 1,
    state: 'bound',
    providers: [{
      provider: 'github',
      instance: 'github.com',
      accountId: 'github.com#7',
      primaryRemote: 'origin',
      readiness: 'ready',
      endpoint: { displayUrl: remoteUrl, fingerprint: 'origin-fetch' },
      repository: { owner, name },
    }],
    remotes: [],
    auxiliary: [],
  },
});

describe('repository filter memory', () => {
  test('round-trips a filter, trimming labels, dropping duplicates and keeping the first 20', () => {
    const key = keyOf('app');
    expect(savedRepositoryFilter(key)).toBeNull();
    rememberRepositoryFilter(key, filter({
      state: 'closed',
      people: 'assigned',
      labels: [' bug ', 'bug', '', 'docs', ...Array.from({ length: 25 }, (_, index) => `label-${index}`)],
    }));

    const saved = savedRepositoryFilter(key);
    expect(saved?.state).toBe('closed');
    expect(saved?.people).toBe('assigned');
    expect(saved?.labels).toHaveLength(20);
    expect(saved?.labels.slice(0, 2)).toEqual(['bug', 'docs']);

    // A reload reads the same entry from storage.
    expect(JSON.parse(store.get(STORAGE_KEY) ?? '[]')).toHaveLength(1);
  });

  test('drops one malformed entry and keeps the rest', () => {
    const good = keyOf('app');
    store.set(STORAGE_KEY, JSON.stringify([
      [good, { state: 'closed', people: 'assigned', labels: [' bug ', 'bug'] }],
      [keyOf('unknown-state'), { state: 'bogus', people: 'any', labels: [] }],
      [keyOf('unknown-people'), { state: 'open', people: 'nobody', labels: [] }],
      [keyOf('no-labels'), { state: 'open', people: 'any' }],
      [keyOf('not-an-object'), 'closed'],
      ['too', 'many', 'parts'],
      42,
    ]));

    expect(savedRepositoryFilter(good)).toEqual(filter({ state: 'closed', people: 'assigned', labels: ['bug'] }));
    expect(savedRepositoryFilter(keyOf('unknown-state'))).toBeNull();
    expect(savedRepositoryFilter(keyOf('unknown-people'))).toBeNull();
    expect(savedRepositoryFilter(keyOf('no-labels'))).toBeNull();

    // Writing again keeps the good entry and discards the malformed ones.
    rememberRepositoryFilter(keyOf('other'), filter({ state: 'all' }));
    expect(savedRepositoryFilter(good)?.state).toBe('closed');
    expect(JSON.parse(store.get(STORAGE_KEY) ?? '[]')).toHaveLength(2);
  });

  test('caps the stored entries at 500, trimming the oldest', () => {
    for (let index = 0; index < 501; index += 1) {
      rememberRepositoryFilter(keyOf(`repo-${index}`), filter({ state: index % 2 === 0 ? 'open' : 'closed' }));
    }
    // SAFETY: the assertion names the array rememberRepositoryFilter just wrote.
    const entries = JSON.parse(store.get(STORAGE_KEY) ?? '[]') as Array<[string, RepositoryReferenceFilter]>;
    expect(entries).toHaveLength(500);
    expect(savedRepositoryFilter(keyOf('repo-0'))).toBeNull();
    expect(savedRepositoryFilter(keyOf('repo-500'))?.state).toBe('open');
  });

  test('never throws when storage is blocked', () => {
    const blocked = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    Object.defineProperty(globalThis, 'window', { value: { localStorage: blocked }, configurable: true });

    // A thrown error would fail the test.
    rememberRepositoryFilter(keyOf('app'), filter({ state: 'closed' }));
    expect(savedRepositoryFilter(keyOf('app'))).toBeNull();
  });

  test('normalises the key, so a fork clone and its upstream share an entry and two projects do not', () => {
    // The binding names the upstream project; the clone's remote points at the fork.
    const upstream = projectOfBinding(
      binding('upstream', 'app', 'https://github.com/fork/app'),
      'github',
      'github.com',
      [],
      [],
    );
    expect(upstream).toEqual({ owner: 'upstream', repo: 'app' });

    const upstreamKey = repositoryFilterKey('github', 'github.com', upstream ?? { owner: '', repo: '' }, 'issue');
    expect(upstreamKey).toBe(repositoryFilterKey('GitHub', 'GitHub.com', { owner: 'Upstream', repo: 'App' }, 'issue'));
    expect(upstreamKey).toBe(keyOf('app', 'issue', 'upstream'));
    expect(upstreamKey).not.toBe(keyOf('app', 'pull', 'upstream'));
    expect(upstreamKey).not.toBe(keyOf('other', 'issue', 'upstream'));

    rememberRepositoryFilter(upstreamKey, filter({ labels: ['bug'] }));
    expect(savedRepositoryFilter(keyOf('app', 'issue', 'upstream'))?.labels).toEqual(['bug']);
    expect(savedRepositoryFilter(keyOf('other', 'issue', 'upstream'))).toBeNull();
  });
});
