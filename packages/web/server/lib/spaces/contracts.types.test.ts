import { describe, expect, expectTypeOf, it } from 'vitest';

import { parseSpaceLabels } from './labels.js';
import { createModelGrants } from './model-grants.js';
import { createRegistryToolsSource, readHostToolVersions } from './tools.js';

describe('space boundary types', () => {
  it('does not turn coercible labels into checked strings', () => {
    const id = [123456789012];
    const labels = parseSpaceLabels({
      'openchamber.space': 'true',
      'openchamber.space.id': id,
      'openchamber.space.role': 'space',
      'openchamber.space.owner': 'owner',
      'openchamber.space.name': 7,
    });
    expect(labels?.id).toBe(id);
    expect(labels?.name).toBe(7);
    expectTypeOf(labels?.id).toBeUnknown();
    expectTypeOf(labels?.name).toBeUnknown();
  });

  it('keeps version values that the coercing pattern accepts', () => {
    const version = ['1.2.3'];
    const source = createRegistryToolsSource({ webVersion: version, openCodeVersion: '2.3.0' });
    expect(source.canonical.packages['@openchamber/web']).toBe(version);
    expectTypeOf(source.canonical.packages['@openchamber/web']).toBeUnknown();
    expectTypeOf<ReturnType<typeof readHostToolVersions>['webVersion']>().toBeUnknown();
  });

  it('keeps the environment secret check for inherited dictionary entries', async () => {
    const environment: NodeJS.ProcessEnv = {};
    const grants = createModelGrants({
      hostCatalog: { read: async () => null, list: async () => [], readStoredKey: async () => null },
      readHostSecret: (name) => environment[name],
    });
    await expect(grants.modelGrantOf({
      kind: 'model',
      provider: 'openai',
      upstream: 'https://api.openai.com/v1',
      secret: { kind: 'env', name: 'constructor' },
    }, null)).rejects.toMatchObject({ code: 'secret_source_missing' });
  });
});
