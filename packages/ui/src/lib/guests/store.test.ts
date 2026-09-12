import { describe, expect, test } from 'bun:test';

import { useGuestsStore } from './store.ts';
import type { InstalledGuest } from './types.ts';

const hello: InstalledGuest = {
  id: 'hello',
  name: 'Hello',
  icon: 'window',
  entry: 'panel/index.html',
  source: 'path',
  capabilities: { requested: [], granted: [] },
};

const resetStore = () => {
  useGuestsStore.setState({ status: 'idle', guests: [], runtimeKey: '' });
};

describe('useGuestsStore', () => {
  test('drops the previous instance catalog on switch', () => {
    resetStore();
    useGuestsStore.getState().resetForRuntimeSwitch('instance-a');
    useGuestsStore.getState().replaceCatalog([hello], 'instance-a');
    expect(useGuestsStore.getState().guests).toEqual([hello]);

    useGuestsStore.getState().resetForRuntimeSwitch('instance-b');
    expect(useGuestsStore.getState().status).toBe('idle');
    expect(useGuestsStore.getState().guests).toEqual([]);
    expect(useGuestsStore.getState().runtimeKey).toBe('instance-b');
  });

  test('ignores a catalog that arrives after the instance changed', () => {
    resetStore();
    useGuestsStore.getState().resetForRuntimeSwitch('instance-a');
    useGuestsStore.getState().replaceCatalog([hello], 'instance-a');
    useGuestsStore.getState().resetForRuntimeSwitch('instance-b');

    useGuestsStore.getState().replaceCatalog([hello], 'instance-a');
    useGuestsStore.getState().markFailed('instance-a');

    expect(useGuestsStore.getState().status).toBe('idle');
    expect(useGuestsStore.getState().guests).toEqual([]);
    expect(useGuestsStore.getState().runtimeKey).toBe('instance-b');
  });

  test('marks vscode and mobile as unsupported, not an empty ready catalog', () => {
    resetStore();
    useGuestsStore.getState().resetForRuntimeSwitch('vscode-a');
    useGuestsStore.getState().markUnsupported('vscode-a');
    expect(useGuestsStore.getState().status).toBe('unsupported');
    expect(useGuestsStore.getState().guests).toEqual([]);

    useGuestsStore.getState().markUnsupported('other');
    expect(useGuestsStore.getState().status).toBe('unsupported');
    expect(useGuestsStore.getState().runtimeKey).toBe('vscode-a');
  });

  test('keeps a ready catalog when a later fetch on the same instance fails', () => {
    resetStore();
    useGuestsStore.getState().resetForRuntimeSwitch('instance-a');
    useGuestsStore.getState().replaceCatalog([hello], 'instance-a');
    useGuestsStore.getState().markFailed('instance-a');
    expect(useGuestsStore.getState().status).toBe('ready');
    expect(useGuestsStore.getState().guests).toEqual([hello]);
  });

  test('overlays update checks without touching untouched rows', () => {
    resetStore();
    const gitGuest: InstalledGuest = { ...hello, id: 'git-one', source: 'git', origin: { url: 'https://github.com/acme/one.git' } };
    const other: InstalledGuest = { ...hello, id: 'git-two', source: 'git', origin: { url: 'https://github.com/acme/two.git' } };
    useGuestsStore.getState().resetForRuntimeSwitch('instance-a');
    useGuestsStore.getState().replaceCatalog([hello, gitGuest, other], 'instance-a');

    useGuestsStore.getState().applyUpdates({ 'git-one': { version: '1.1.0' } }, 'instance-a');
    const [first, second, third] = useGuestsStore.getState().guests;
    expect(first).toBe(hello);
    expect(second.update).toEqual({ version: '1.1.0' });
    expect(third).toBe(other);

    // Same answer again: no new array.
    const before = useGuestsStore.getState().guests;
    useGuestsStore.getState().applyUpdates({ 'git-one': { version: '1.1.0' } }, 'instance-a');
    expect(useGuestsStore.getState().guests).toBe(before);

    // The update went away (installed, or the remote moved back).
    useGuestsStore.getState().applyUpdates({}, 'instance-a');
    expect(useGuestsStore.getState().guests[1]).toEqual(gitGuest);
    expect('update' in useGuestsStore.getState().guests[1]).toBe(false);

    // A stale instance answer is ignored.
    useGuestsStore.getState().applyUpdates({ 'git-one': { version: '9.0.0' } }, 'instance-b');
    expect(useGuestsStore.getState().guests[1].update).toBeUndefined();
  });
});
