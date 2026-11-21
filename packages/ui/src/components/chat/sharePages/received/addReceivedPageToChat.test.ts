import { describe, expect, test } from 'bun:test';

import { holdsSharedPage, sharedPageChipFor } from './addReceivedPageToChat';

describe('Add to chat', () => {
  const page = { receivedId: 'rp_1', host: 'share.openchamber.dev', title: 'Pick', opened: true };

  test('puts the page on the composer by its id, with no link or key', () => {
    const chip = sharedPageChipFor(page);
    expect(chip).toMatchObject({ kind: 'shared-page', shareKey: 'rp_1', receivedId: 'rp_1', title: 'Pick', opened: true });
    expect(JSON.stringify(chip)).not.toContain('/p/');
  });

  test('sees the page already on a composer, also as a chip pasted from its link', () => {
    const pasted = { ...sharedPageChipFor(page), shareKey: 'share.openchamber.dev/AbCdEfGhIjKlMnOpQrStUv' };
    expect(holdsSharedPage([pasted], 'rp_1')).toBe(true);
    expect(holdsSharedPage([{ ...pasted, receivedId: null }], 'rp_1')).toBe(false);
    expect(holdsSharedPage([], 'rp_1')).toBe(false);
  });
});
