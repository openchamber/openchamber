import { describe, expect, test } from 'bun:test';

import {
  flattenPreferences,
  migrateWideChatLayoutDocument,
  migrateWideChatLayoutPreferenceFields,
} from './settings-files.js';

describe('wide chat layout migration', () => {
  test('maps stored switches to chat width levels and drops the switch', () => {
    const fields = migrateWideChatLayoutPreferenceFields({
      wideChatLayoutEnabled: {
        value: false,
        updatedAt: 5,
        surfaces: { desktop: { value: true, updatedAt: 7 } },
      },
    });

    expect(fields.wideChatLayoutEnabled).toBeUndefined();
    expect(flattenPreferences(fields)).toEqual({ chatWidth: 'compact' });
    expect(flattenPreferences(fields, 'desktop')).toEqual({ chatWidth: 'full' });
    expect(fields.chatWidth.updatedAt).toBe(5);
  });

  test('keeps a chat width already stored', () => {
    const fields = migrateWideChatLayoutPreferenceFields({
      chatWidth: { value: 'standard', updatedAt: 9 },
      wideChatLayoutEnabled: { value: true, updatedAt: 4 },
    });

    expect(fields.chatWidth).toEqual({ value: 'standard', updatedAt: 9 });
    expect(fields.wideChatLayoutEnabled).toBeUndefined();
  });

  test('converts the switch in a plain settings document', () => {
    expect(migrateWideChatLayoutDocument({ wideChatLayoutEnabled: true })).toEqual({ chatWidth: 'full' });
    expect(migrateWideChatLayoutDocument({ chatWidth: 'full', wideChatLayoutEnabled: false })).toEqual({ chatWidth: 'full' });
    expect(migrateWideChatLayoutDocument({ locale: 'fr' })).toEqual({ locale: 'fr' });
  });
});
