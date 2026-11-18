import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { expectTypeOf, it } from 'vitest';
import { createManagedTunnelConfigRuntime } from './managed-config.js';
import type { ManagedRemoteTunnelConfig, ManagedRemoteTunnelTokenInput } from './managed-config.js';

it('keeps the preset input contract owned by the injected normalizer', () => {
  const runtime = createManagedTunnelConfigRuntime({
    fsPromises,
    path,
    normalizeManagedRemoteTunnelHostname: () => undefined,
    normalizeManagedRemoteTunnelPresets: (value: { savedNames: string[] }) =>
      value.savedNames.map((name) => ({ id: name, name, hostname: `${name}.example.com` })),
    constants: {
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: '/unused/managed.json',
      CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: '/unused/legacy.json',
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
    },
  });
  expectTypeOf(runtime.syncManagedRemoteTunnelConfigWithPresets).parameter(0).toEqualTypeOf<{ savedNames: string[] }>();
  expectTypeOf(runtime.upsertManagedRemoteTunnelToken).parameter(0).toEqualTypeOf<ManagedRemoteTunnelTokenInput>();
  expectTypeOf(runtime.readManagedRemoteTunnelConfigFromDisk).returns.toEqualTypeOf<Promise<ManagedRemoteTunnelConfig>>();
});
