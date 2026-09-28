import { describe, expect, test } from 'bun:test';

import type { InstalledGuest } from '@/lib/guests/types';
import { EXCALIDRAW_EXTENSION, getCatalogExtensionState } from './catalogExtensions';

const installed = (overrides: Partial<InstalledGuest> = {}): InstalledGuest => ({
  id: 'excalidraw',
  name: 'Excalidraw',
  icon: 'icon.svg',
  version: '1.0.0',
  capabilities: { requested: [], granted: [] },
  ...overrides,
});

describe('getCatalogExtensionState', () => {
  test('follows the installed catalog by extension id', () => {
    expect(getCatalogExtensionState([], EXCALIDRAW_EXTENSION)).toEqual({ kind: 'not-installed' });
    expect(getCatalogExtensionState([installed({ id: 'other' })], EXCALIDRAW_EXTENSION)).toEqual({ kind: 'not-installed' });
    expect(getCatalogExtensionState([installed()], EXCALIDRAW_EXTENSION)).toMatchObject({ kind: 'installed' });
    expect(getCatalogExtensionState([installed({ update: { version: '1.1.0' } })], EXCALIDRAW_EXTENSION))
      .toMatchObject({ kind: 'update-available', version: '1.1.0' });
  });

  test('approval and pause outrank an update, since the extension does nothing until they are resolved', () => {
    const unapproved = installed({ capabilities: { requested: ['files'], granted: [] }, enabled: false, update: { version: '2.0.0' } });
    expect(getCatalogExtensionState([unapproved], EXCALIDRAW_EXTENSION)).toMatchObject({ kind: 'needs-approval' });
    expect(getCatalogExtensionState([installed({ enabled: false, update: { version: '2.0.0' } })], EXCALIDRAW_EXTENSION))
      .toMatchObject({ kind: 'paused' });
  });
});
