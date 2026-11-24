import { describe, expect, test } from 'bun:test';

import type { ComposerReference } from './composerReferences';
import { getSafeStorage } from '@/stores/utils/safeStorage';

import { parseSharedPageChips, readStoredSharedPageChips, serializeSharedPageChips, storeSharedPageChips } from './sharedPageChipDrafts';

const STORAGE_KEY = 'openchamber.sharedPageChips.v1';

const page = (overrides: Partial<Extract<ComposerReference, { kind: 'shared-page' }>> = {}): ComposerReference => ({
  kind: 'shared-page',
  shareKey: 'share.openchamber.dev/AbCdEfGhIjKlMnOpQrStUv',
  receivedId: 'rp_1',
  host: 'share.openchamber.dev',
  title: 'Pick a schema',
  opened: true,
  contextText: '<openchamber-shared-page>secret page body</openchamber-shared-page>',
  ...overrides,
});

describe('page chips kept across reloads', () => {
  test('keep only what names the page, and come back to be opened again from the server', () => {
    const issue: ComposerReference = { kind: 'repository-issue', number: 1, title: 'Bug', url: 'https://x/1', contextText: 'body' };
    const raw = serializeSharedPageChips(new Map([['draft-a', [issue, page()]], ['draft-b', [page({ receivedId: null, shareKey: 'pending' })]]]));
    expect(raw).not.toContain('secret page body');
    expect(raw).not.toContain('https://x/1');
    const restored = parseSharedPageChips(raw);
    expect([...restored.keys()]).toEqual(['draft-a']);
    expect(restored.get('draft-a')).toMatchObject([{ kind: 'shared-page', receivedId: 'rp_1', title: 'Pick a schema', opened: false }]);
    expect(restored.get('draft-a')?.[0].contextText).toContain('opened="false"');
  });

  test('a save in one window keeps the chips another window saved for other drafts', () => {
    const storage = getSafeStorage();
    storage.removeItem(STORAGE_KEY);
    readStoredSharedPageChips();
    storage.setItem(STORAGE_KEY, serializeSharedPageChips(new Map([['draft-b', [page({ receivedId: 'rp_b' })]]]))!);
    const stored = () => [...parseSharedPageChips(storage.getItem(STORAGE_KEY))].map(([key, chips]) => [key, chips.map((chip) => chip.receivedId)]);

    storeSharedPageChips(new Map([['draft-a', [page()]]]));
    expect(stored()).toEqual([['draft-b', ['rp_b']], ['draft-a', ['rp_1']]]);

    storage.setItem(STORAGE_KEY, serializeSharedPageChips(new Map([
      ['draft-b', [page({ receivedId: 'rp_b' })]], ['draft-a', [page()]], ['draft-c', [page({ receivedId: 'rp_c' })]],
    ]))!);
    storeSharedPageChips(new Map([['draft-a', [page()]], ['draft-d', [page({ receivedId: 'rp_d' })]]]));
    expect(stored()).toEqual([['draft-b', ['rp_b']], ['draft-a', ['rp_1']], ['draft-c', ['rp_c']], ['draft-d', ['rp_d']]]);

    storeSharedPageChips(new Map([['draft-d', [page({ receivedId: 'rp_d' })]]]));
    expect(stored()).toEqual([['draft-b', ['rp_b']], ['draft-c', ['rp_c']], ['draft-d', ['rp_d']]]);
  });

  test('read nothing from storage they cannot parse', () => {
    expect(parseSharedPageChips(null).size).toBe(0);
    expect(parseSharedPageChips('{').size).toBe(0);
    expect(parseSharedPageChips('{"version":1,"drafts":{"a":[{"receivedId":5}]}}').size).toBe(0);
    expect(serializeSharedPageChips(new Map())).toBeNull();
  });
});
