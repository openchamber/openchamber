import { describe, expect, test } from 'bun:test';

import type { ComposerReference } from './composerReferences';
import { parseSharedPageChips, serializeSharedPageChips } from './sharedPageChipDrafts';

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

  test('read nothing from storage they cannot parse', () => {
    expect(parseSharedPageChips(null).size).toBe(0);
    expect(parseSharedPageChips('{').size).toBe(0);
    expect(parseSharedPageChips('{"version":1,"drafts":{"a":[{"receivedId":5}]}}').size).toBe(0);
    expect(serializeSharedPageChips(new Map())).toBeNull();
  });
});
