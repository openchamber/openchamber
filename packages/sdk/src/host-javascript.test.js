import { expect, test } from 'bun:test';
import { connectHost } from './host.ts';
import { isGuestPopoverRequest } from './popover.ts';

// Exercise a JavaScript consumer directly, without casting invalid options into TS types.
test('JavaScript storage callers cannot silently fall back after misspelling a scope', async () => {
  const posted = [];
  const host = connectHost({ target: {
    addEventListener() {},
    removeEventListener() {},
    parent: { postMessage(message) { posted.push(message); } },
  } });
  const invalid = { scope: 'devcie' };
  try {
    await expect(host.storage.get('saved', invalid)).rejects.toMatchObject({ code: 'HOST_REJECTED' });
    await expect(host.storage.set('saved', true, invalid)).rejects.toMatchObject({ code: 'HOST_REJECTED' });
    await expect(host.storage.delete('saved', invalid)).rejects.toMatchObject({ code: 'HOST_REJECTED' });
    await expect(host.storage.keys(invalid)).rejects.toMatchObject({ code: 'HOST_REJECTED' });
    expect(posted.map(message => message.type)).toEqual(['hello']);
  } finally { host.dispose(); }
});

test('JavaScript popover callers fail before posting values the host cannot accept', () => {
  const request = { id: 'preview', anchor: { x: 0, y: 0, width: 20, height: 20 }, width: 340, height: 180 };
  for (const data of [NaN, { count: Infinity }, { callback() {} }, { value: undefined }, new Date()]) {
    expect(isGuestPopoverRequest({ ...request, data })).toBe(false);
  }
  expect(isGuestPopoverRequest({ ...request, data: { count: 0, empty: null } })).toBe(true);
});

test('shared-reference popover data has a bounded validation work budget', () => {
  let reads = 0;
  let data = { get value() { reads++; return null; } };
  for (let depth = 0; depth < 24; depth++) data = [data, data];
  expect(isGuestPopoverRequest({ id: 'preview', anchor: { x: 0, y: 0, width: 20, height: 20 }, width: 340, height: 180, data })).toBe(false);
  expect(reads).toBeLessThan(16000);
});
