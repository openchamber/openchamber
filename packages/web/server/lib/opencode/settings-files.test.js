import { describe, expect, test } from 'bun:test';

import {
  flattenPreferences,
  migrateWideChatLayoutDocument,
  migrateWideChatLayoutPreferenceFields,
  parsePreferencesDocument,
  serializePreferencesDocument,
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
    expect(flattenPreferences(fields, 'desktop')).toEqual({ chatWidth: 'full-width' });
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
    expect(migrateWideChatLayoutDocument({ wideChatLayoutEnabled: true })).toEqual({ chatWidth: 'full-width' });
    expect(migrateWideChatLayoutDocument({ chatWidth: 'full', wideChatLayoutEnabled: false })).toEqual({ chatWidth: 'full' });
    expect(migrateWideChatLayoutDocument({ locale: 'fr' })).toEqual({ locale: 'fr' });
  });

  test('drops a switch that has no usable value without writing an unparseable entry', () => {
    const fields = migrateWideChatLayoutPreferenceFields({
      wideChatLayoutEnabled: { value: null, updatedAt: 4 },
    });

    expect(fields).toEqual({});
    expect(parsePreferencesDocument(serializePreferencesDocument(fields)).ok).toBe(true);
  });

  test('keeps a surfaces-only switch as per-surface chat width levels', () => {
    const fields = migrateWideChatLayoutPreferenceFields({
      wideChatLayoutEnabled: {
        surfaces: { desktop: { value: true, updatedAt: 3 } },
        updatedAt: 4,
      },
    });

    expect(fields).toEqual({
      chatWidth: {
        surfaces: { desktop: { value: 'full-width', updatedAt: 3 } },
        updatedAt: 4,
      },
    });
    expect(parsePreferencesDocument(serializePreferencesDocument(fields)).ok).toBe(true);
  });
});
