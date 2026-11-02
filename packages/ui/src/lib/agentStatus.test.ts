import { describe, expect, test } from 'bun:test';

import { applyPlural, formatAgentStatus } from './agentStatus';
import type { I18nKey, I18nParams } from '@/lib/i18n';

const dictionary = new Map(Object.entries({
  'chat.agentStatus.read.count': 'читає {count, plural, one {# файл} few {# файли} many {# файлів} other {# файлу}}',
  'chat.agentStatus.command': 'виконує команду',
  'chat.agentStatus.usingTool': 'використовує {name}',
  'chat.statusRow.modelStatus': '{model} {status}',
}));
const t = (key: I18nKey, params?: I18nParams): string => {
  const template = dictionary.get(key) ?? key;
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match)) : template;
};

describe('applyPlural', () => {
  test('picks the locale\'s plural category and writes the number', () => {
    const template = '{count, plural, one {# файл} few {# файли} many {# файлів} other {# файлу}}';
    expect(applyPlural(template, 2, 'uk')).toBe('2 файли');
    expect(applyPlural(template, 5, 'uk')).toBe('5 файлів');
    expect(applyPlural(template, 21, 'uk')).toBe('21 файл');
  });

  test('an exact case wins, and other covers a missing category', () => {
    expect(applyPlural('{count, plural, =2 {both} other {# of them}}', 2, 'en')).toBe('both');
    expect(applyPlural('{count, plural, other {# files}}', 3, 'en')).toBe('3 files');
  });

  test('the number uses the locale\'s digits', () => {
    expect(applyPlural('{count, plural, other {#}}', 3, 'ar')).toBe(new Intl.NumberFormat('ar').format(3));
  });
});

describe('formatAgentStatus', () => {
  test('follows the model through the locale\'s template', () => {
    expect(formatAgentStatus(t, 'uk', { key: 'chat.agentStatus.command' }, 'Opus 5.5')).toBe('Opus 5.5 виконує команду');
  });

  test('stands alone with a capital first letter without a model', () => {
    expect(formatAgentStatus(t, 'uk', { key: 'chat.agentStatus.command' }, null)).toBe('Виконує команду');
    expect(formatAgentStatus(t, 'uk', { key: 'chat.agentStatus.read.count', count: 3 }, '  ')).toBe('Читає 3 файли');
  });

  test('names the tool it does not know', () => {
    expect(formatAgentStatus(t, 'uk', { key: 'chat.agentStatus.usingTool', name: 'jev route' })).toBe('Використовує jev route');
    expect(formatAgentStatus(t, 'uk', { key: 'chat.agentStatus.usingTool', name: "cash$&tool $$ $' $`" })).toBe("Використовує cash$&tool $$ $' $`");
  });
});
