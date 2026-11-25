import { describe, expect, test } from 'bun:test';

import { imageAnnotationI18n } from './image-annotation.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('image annotation translations', () => {
    test('every locale has every key', () => {
        const englishKeys = Object.keys(imageAnnotationI18n.en).sort();
        for (const locale of locales) {
            // SAFETY: every locale block is a flat string map; the key list is checked against English below.
            const dictionary = imageAnnotationI18n[locale] as Record<string, string>;
            expect(Object.keys(dictionary).sort()).toEqual(englishKeys);
            for (const key of englishKeys) {
                expect(dictionary[key]?.trim()).toBeTruthy();
            }
        }
    });
});