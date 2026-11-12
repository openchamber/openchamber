import { describe, expect, test } from 'bun:test';
import { linearPanelI18n } from './linear-panel.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

const requiredKeys = [
  'tracker.priority.urgent',
  'tracker.priority.high',
  'tracker.priority.medium',
  'tracker.priority.low',
] as const;

const matchingEnglishAllowed = new Set<string>([
  'contextPanel.mode.linear',
  'contextPanel.linear.label.status',
  'contextPanel.linear.label.team',
  // "Labels", "Urgent" and "Backlog" are the same words in Dutch.
  'contextPanel.linear.label.labels',
  'tracker.priority.urgent',
  'contextPanel.linear.filter.status.backlog',
]);

describe('tracker priority translations', () => {
  test('provides every required key in every supported locale', () => {
    const english = linearPanelI18n.en;
    for (const locale of locales) {
      for (const key of requiredKeys) {
        const value = linearPanelI18n[locale][key];
        expect(value).toBeTruthy();
        if (locale !== 'en' && !matchingEnglishAllowed.has(key)) {
          expect(value).not.toBe(english[key]);
        }
      }
    }
  });
});
