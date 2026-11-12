import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createExtensionProviders } from './extension-providers.js';

const contribution = JSON.parse(fs.readFileSync(
  new URL('../../../../sdk/examples/source-control-provider/package.json', import.meta.url), 'utf8',
)).openchamber.contributes.sourceControl;

const guest = (overrides = {}) => ({
  id: 'forge', name: 'Forge', version: '1.0.0', packageRoot: '/pkg/forge', enabled: true,
  service: { entry: 'service/main.js', runtime: 'host', provides: ['source-control'] },
  sourceControl: contribution, capabilityGrants: ['service'], ...overrides,
});

let catalog;
let deps;
let providers;

beforeEach(() => {
  catalog = [];
  deps = {
    listGuests: vi.fn(async () => catalog),
    register: vi.fn(),
    unregister: vi.fn(),
    dropSection: vi.fn(async () => true),
    emitChanged: vi.fn(),
  };
  providers = createExtensionProviders(deps);
});

const registeredIds = () => deps.register.mock.calls.map(([{ descriptor }]) => descriptor.id);

describe('extension providers follow the catalog', () => {
  it.each([
    ['paused', { enabled: false }],
    ['not approved', { capabilityGrants: [] }],
    ['without the role', { service: { entry: 'service/main.js', runtime: 'host', provides: ['browser'] } }],
    ['without a contribution', { sourceControl: undefined }],
    ['with an id too long for a provider', { id: 'a'.repeat(29) }],
  ])('leaves out a guest that is %s', async (_name, overrides) => {
    catalog = [guest(overrides)];
    await providers.reconcile();
    expect(deps.register).not.toHaveBeenCalled();
    expect(deps.emitChanged).not.toHaveBeenCalled();
  });

  it('registers an eligible guest once, and again only when it changed', async () => {
    catalog = [guest()];
    await providers.reconcile();
    await providers.reconcile();
    expect(registeredIds()).toEqual(['ext-forge']);
    expect(deps.emitChanged).toHaveBeenCalledOnce();
    const first = deps.register.mock.calls[0][0].descriptor;
    expect(first.extension).toMatchObject({ guestId: 'forge', version: '1.0.0' });

    // Same version and contribution, moved package: the descriptor is kept.
    catalog = [guest({ packageRoot: '/pkg/forge-2' })];
    await providers.reconcile();
    expect(deps.register.mock.calls[1][0].descriptor).toBe(first);
    expect(deps.register.mock.calls[1][0].guest.packageRoot).toBe('/pkg/forge-2');

    catalog = [guest({ packageRoot: '/pkg/forge-2', version: '1.1.0' })];
    await providers.reconcile();
    expect(deps.register.mock.calls[2][0].descriptor).not.toBe(first);
    expect(deps.emitChanged).toHaveBeenCalledTimes(3);
  });

  it('unregisters a guest that stopped being eligible, and forgets accounts only on removal', async () => {
    catalog = [guest()];
    await providers.reconcile();
    catalog = [guest({ enabled: false })];
    await providers.deactivated({ guestId: 'forge' });
    expect(deps.unregister).toHaveBeenCalledWith('ext-forge');
    expect(deps.dropSection).not.toHaveBeenCalled();
    catalog = [];
    await providers.deactivated({ guestId: 'forge', removed: true });
    expect(deps.unregister).toHaveBeenCalledOnce();
    expect(deps.dropSection).toHaveBeenCalledWith('ext-forge');
  });

  it('keeps the providers as they are when the catalog cannot be read', async () => {
    catalog = [guest()];
    await providers.reconcile();
    deps.listGuests.mockRejectedValueOnce(new Error('disk'));
    await expect(providers.reconcile()).rejects.toThrow('disk');
    expect(deps.unregister).not.toHaveBeenCalled();
    // The next run still runs.
    catalog = [];
    await providers.reconcile();
    expect(deps.unregister).toHaveBeenCalledWith('ext-forge');
  });

  it('one broken contribution leaves the other providers registered', async () => {
    catalog = [guest(), guest({ id: 'broken', sourceControl: { ...contribution, wire: 2 } })];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await providers.reconcile();
    warn.mockRestore();
    expect(registeredIds()).toEqual(['ext-forge']);
  });

  it('runs one reconcile at a time', async () => {
    let release;
    deps.listGuests.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([guest()]); }));
    const first = providers.reconcile();
    catalog = [];
    const second = providers.reconcile();
    await Promise.resolve();
    expect(deps.listGuests).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    expect(deps.register).toHaveBeenCalledOnce();
    expect(deps.unregister).toHaveBeenCalledWith('ext-forge');
  });
});
