import { describe, expect, test } from 'bun:test';
import {
  getComposerStatusContributions,
  getRegisteredUIPluginManifests,
  isComposerStatusContributionSupported,
  parseUIPluginManifest,
  registerUIPluginManifest,
} from './uiPlugins';

const composerStatusManifest = (mutate?: (contribution: Record<string, unknown>) => void) => {
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    id: '@example/session-status',
    version: '0.1.0',
    displayName: { default: 'Session Status' },
    description: { default: 'Paint a chip in the composer footer.' },
    engines: { openchamber: '>=1.0.0' },
    contributes: {
      composerStatus: [{
        id: 'session-status',
        placement: 'footer',
        support: {
          web: 'supported',
          desktop: 'supported',
          vscode: 'unsupported',
          hostedMobile: 'supported',
          capacitorMobile: 'supported',
        },
      }],
    },
  };
  mutate?.(((manifest.contributes as Record<string, unknown>).composerStatus as Array<Record<string, unknown>>)[0]!);
  return manifest;
};

describe('declarative UI plugin registry', () => {
  test('ships no composer status contributions of its own', () => {
    expect(getComposerStatusContributions(getRegisteredUIPluginManifests())).toEqual([]);
  });

  test('registers and unregisters composer status contributions', () => {
    const unregister = registerUIPluginManifest(composerStatusManifest());
    const contributions = getComposerStatusContributions().filter((entry) => entry.id === 'session-status');
    expect(contributions).toHaveLength(1);
    expect(contributions[0]?.placement).toBe('footer');
    expect(isComposerStatusContributionSupported(contributions[0]!, 'web')).toBe(true);
    expect(isComposerStatusContributionSupported(contributions[0]!, 'vscode')).toBe(false);
    unregister();
    expect(getComposerStatusContributions().some((entry) => entry.id === 'session-status')).toBe(false);
  });

  test('rejects a second registration of the same plugin id', () => {
    const unregister = registerUIPluginManifest(composerStatusManifest());
    expect(() => registerUIPluginManifest(composerStatusManifest())).toThrow('already registered');
    unregister();
  });

  test('rejects a manifest that is not schema version 1', () => {
    expect(() => parseUIPluginManifest({ ...composerStatusManifest(), schemaVersion: 2 })).toThrow('Invalid OpenChamber UI plugin manifest');
  });

  test('rejects duplicate composer status contribution ids inside one manifest', () => {
    expect(parseUIPluginManifest(composerStatusManifest()).contributes.composerStatus?.[0]?.id).toBe('session-status');
    const manifest = composerStatusManifest();
    const contributes = manifest.contributes as { composerStatus: Array<Record<string, unknown>> };
    contributes.composerStatus.push({ ...contributes.composerStatus[0]! });
    expect(() => parseUIPluginManifest(manifest)).toThrow('Invalid composer-status contribution');
  });

  test('rejects invalid composer status placements', () => {
    expect(() => parseUIPluginManifest(composerStatusManifest((contribution) => {
      contribution.placement = 'header';
    }))).toThrow('Invalid composer-status contribution');
    const manifest = composerStatusManifest();
    (manifest.contributes as { composerStatus: unknown }).composerStatus = { id: 'session-status' };
    expect(() => parseUIPluginManifest(manifest)).toThrow('Invalid composer-status contributions');
  });

  test('rejects composer status support maps that omit or invent runtimes', () => {
    expect(() => parseUIPluginManifest(composerStatusManifest((contribution) => {
      delete (contribution.support as Record<string, unknown>).vscode;
    }))).toThrow('Invalid composer-status contribution');
    expect(() => parseUIPluginManifest(composerStatusManifest((contribution) => {
      (contribution.support as Record<string, unknown>).futureRuntime = 'unsupported';
    }))).toThrow('Invalid composer-status contribution');
    expect(() => parseUIPluginManifest(composerStatusManifest((contribution) => {
      (contribution.support as Record<string, unknown>).web = 'sometimes';
    }))).toThrow('Invalid composer-status contribution');
  });

  test('rejects composer status ids that are not lowercase slugs', () => {
    expect(() => parseUIPluginManifest(composerStatusManifest((contribution) => {
      contribution.id = 'Session_Status';
    }))).toThrow('Invalid composer-status contribution');
  });
});
