import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
};
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', { value: { localStorage: fakeStorage }, configurable: true });
});
afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('repository provider memory', () => {
  test('keeps a project\'s host per runtime, across a reload, and ignores corrupt storage', async () => {
    store.set('openchamber.repositoryProvider.v1', '{not json');
    const first = await import(`./repositoryProviderMemory?first=${Date.now()}`);
    expect(first.rememberedRepositoryProvider('runtime-a', '/projects/app')).toBeNull();

    let notified = 0;
    const unsubscribe = first.subscribeRepositoryProviderMemory(() => { notified += 1; });
    first.rememberRepositoryProvider('runtime-a', '/projects/app', 'gitlab');
    first.rememberRepositoryProvider('runtime-a', '/projects/app', 'gitlab');
    unsubscribe();
    expect(notified).toBe(1);
    expect(first.rememberedRepositoryProvider('runtime-a', '/projects/app')).toBe('gitlab');
    // The same path on another machine is another project.
    expect(first.rememberedRepositoryProvider('runtime-b', '/projects/app')).toBeNull();

    const reloaded = await import(`./repositoryProviderMemory?second=${Date.now()}`);
    expect(reloaded.rememberedRepositoryProvider('runtime-a', '/projects/app')).toBe('gitlab');
  });

  test('keeps any served provider id, old and new, and drops only a malformed entry', async () => {
    const key = (path: string) => `runtime-a\u0000${path}`;
    store.set('openchamber.repositoryProvider.v1', JSON.stringify([
      [key('/projects/old'), 'github'],
      [key('/projects/bad'), 'Bad Id'],
      [key('/projects/new'), 'acme'],
    ]));
    const memory = await import(`./repositoryProviderMemory?open=${Date.now()}`);
    expect(memory.rememberedRepositoryProvider('runtime-a', '/projects/old')).toBe('github');
    expect(memory.rememberedRepositoryProvider('runtime-a', '/projects/bad')).toBeNull();
    expect(memory.rememberedRepositoryProvider('runtime-a', '/projects/new')).toBe('acme');

    memory.rememberRepositoryProvider('runtime-a', '/projects/other', 'acme');
    const reloaded = await import(`./repositoryProviderMemory?openReload=${Date.now()}`);
    expect(reloaded.rememberedRepositoryProvider('runtime-a', '/projects/other')).toBe('acme');
    expect(reloaded.rememberedRepositoryProvider('runtime-a', '/projects/old')).toBe('github');
  });
});
