import { describe, expect, test } from 'bun:test';

import { cssMaskUrl, GUEST_RAIL_ICON_MASK_SIZE } from './GuestRailIcon';

describe('cssMaskUrl', () => {
  test('quotes a tokenized asset url', () => {
    expect(cssMaskUrl('http://127.0.0.1/api/guests/hello/icon.svg?oc_url_token=abc'))
      .toBe('url("http://127.0.0.1/api/guests/hello/icon.svg?oc_url_token=abc")');
  });

  test('escapes quotes in the url', () => {
    expect(cssMaskUrl('x"y')).toBe('url("x\\"y")');
  });
});

describe('GUEST_RAIL_ICON_MASK_SIZE', () => {
  test('keeps package marks optically inside the Remixicon inset', () => {
    expect(GUEST_RAIL_ICON_MASK_SIZE).toBe('84%');
  });
});
