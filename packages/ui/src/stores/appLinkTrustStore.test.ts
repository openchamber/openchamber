import { beforeEach, describe, expect, test } from 'bun:test';

import { useAppLinkTrustStore, MAX_TRUSTED_SCHEMES } from './appLinkTrustStore';

describe('app link trust store', () => {
  beforeEach(() => {
    useAppLinkTrustStore.setState({ trustedSchemes: [] });
  });

  test('trusts a scheme with case and whitespace normalization', () => {
    const store = useAppLinkTrustStore.getState();

    store.trustScheme('  Obsidian ');

    expect(useAppLinkTrustStore.getState().trustedSchemes).toEqual(['obsidian']);
    expect(useAppLinkTrustStore.getState().isSchemeTrusted('OBSIDIAN')).toBe(true);
    expect(useAppLinkTrustStore.getState().isSchemeTrusted('linear')).toBe(false);
  });

  test('re-trusting moves the scheme to the front without duplicates', () => {
    const store = useAppLinkTrustStore.getState();
    store.trustScheme('obsidian');
    store.trustScheme('linear');
    store.trustScheme('obsidian');

    expect(useAppLinkTrustStore.getState().trustedSchemes).toEqual(['obsidian', 'linear']);
  });

  test('removes a trusted scheme', () => {
    const store = useAppLinkTrustStore.getState();
    store.trustScheme('obsidian');
    store.trustScheme('linear');

    useAppLinkTrustStore.getState().removeTrustedScheme('obsidian');

    expect(useAppLinkTrustStore.getState().trustedSchemes).toEqual(['linear']);
    expect(useAppLinkTrustStore.getState().isSchemeTrusted('obsidian')).toBe(false);
  });

  test('caps the stored scheme list', () => {
    const store = useAppLinkTrustStore.getState();
    for (let index = 0; index < MAX_TRUSTED_SCHEMES + 5; index += 1) {
      store.trustScheme(`scheme${index}`);
    }

    const schemes = useAppLinkTrustStore.getState().trustedSchemes;
    expect(schemes).toHaveLength(MAX_TRUSTED_SCHEMES);
    expect(schemes[0]).toBe(`scheme${MAX_TRUSTED_SCHEMES + 4}`);
  });
});
