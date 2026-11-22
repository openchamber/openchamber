import { afterEach, describe, expect, test } from 'bun:test';

import { compileGuestProviderLogos, guestProviderLogoOf } from './provider-logos.ts';
import { useGuestsStore } from './store.ts';
import type { InstalledGuest } from './types.ts';

const guest = (id: string, providerLogos: Record<string, string> | undefined, overrides: Partial<InstalledGuest> = {}): InstalledGuest => ({
  id,
  name: id,
  icon: 'window',
  capabilities: { requested: [], granted: [] },
  source: 'path',
  providerLogos,
  ...overrides,
});

afterEach(() => useGuestsStore.setState({ guests: [] }));

describe('compileGuestProviderLogos', () => {
  test('the first active extension in the catalog wins a provider', () => {
    const logos = compileGuestProviderLogos([
      guest('paused', { acme: 'paused.svg' }, { enabled: false }),
      guest('pending', { acme: 'pending.svg' }, { capabilities: { requested: ['prompt'], granted: [] } }),
      guest('none', undefined),
      guest('first', { acme: 'logos/first.svg' }, { version: '1.2.0', revision: 3 }),
      guest('second', { acme: 'second.svg', 'wafer.ai': 'wafer.PNG' }),
    ]);

    expect([...logos.keys()]).toEqual(['acme', 'wafer.ai']);
    expect(logos.get('acme')).toEqual({ path: '/api/guests/first/logos/first.svg', isSvg: true, version: '1.2.0.3' });
    expect(logos.get('wafer.ai')).toEqual({ path: '/api/guests/second/wafer.PNG', isSvg: false, version: '.0' });
  });

  test('a file name stays one path, whatever it holds', () => {
    const logos = compileGuestProviderLogos([guest('names', { acme: 'my logos/a#b?.svg' })]);

    expect(logos.get('acme')?.path).toBe('/api/guests/names/my%20logos/a%23b%3F.svg');
  });
});

describe('guestProviderLogoOf', () => {
  test('follows the catalog', () => {
    expect(guestProviderLogoOf(['acme'])).toBeNull();
    useGuestsStore.setState({ guests: [guest('first', { acme: 'acme.svg' })] });
    expect(guestProviderLogoOf(['acme'])?.path).toBe('/api/guests/first/acme.svg');
    useGuestsStore.setState({ guests: [guest('first', { acme: 'acme.svg' }, { enabled: false })] });
    expect(guestProviderLogoOf(['acme'])).toBeNull();
  });

  test('the first id with a logo answers', () => {
    useGuestsStore.setState({ guests: [guest('first', { acme: 'acme.svg', other: 'other.svg' })] });
    expect(guestProviderLogoOf(['none', 'other', 'acme'])?.path).toBe('/api/guests/first/other.svg');
  });
});
