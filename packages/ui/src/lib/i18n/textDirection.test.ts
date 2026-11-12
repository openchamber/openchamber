import { describe, expect, test } from 'bun:test';
import { dict as arDict } from './messages/ar';
import { dict as enDict } from './messages/en';
import { formatMessage } from './store';
import { dominantTextDirection, proseTextDirection } from './textDirection';

describe('dominantTextDirection', () => {
  test('goes by most letters, not the first one', () => {
    expect(dominantTextDirection('PWA و نصب‌پذیری', 'افزودن manifest، service worker و پشتیبانی از نصب روی دستگاه')).toBe('rtl');
    expect(dominantTextDirection('PWA و نصب‌پذیری')).toBe('rtl');
    expect(dominantTextDirection('Use the قدم بعدی option')).toBe('ltr');
  });

  test('reads Hebrew and Arabic as right to left', () => {
    expect(dominantTextDirection('rebase בתהליך')).toBe('rtl');
    expect(dominantTextDirection('مرحبا')).toBe('rtl');
  });

  test('has no direction without letters', () => {
    expect(dominantTextDirection('', null, undefined, '42 · 7%')).toBeUndefined();
  });
});

describe('proseTextDirection', () => {
  test('Arabic that opens with a Latin term runs right to left', () => {
    expect(proseTextDirection('React هي مكتبة لبناء واجهات المستخدم')).toBe('rtl');
    expect(proseTextDirection('MCP Server سيرفر محلي بيشغل أوامر على جهازك')).toBe('rtl');
  });

  test('English quoting an Arabic word stays left to right', () => {
    expect(proseTextDirection('translate the label مرحبا for the login screen')).toBe('ltr');
    expect(proseTextDirection('fix the failing test')).toBe('ltr');
  });

  test('a path counts as one word, and inline code and URLs not at all', () => {
    expect(proseTextDirection('عدّل packages/ui/src/index.css')).toBe('rtl');
    expect(proseTextDirection('عدّل `const value = useMemo(() => compute(a, b))` هنا')).toBe('rtl');
    expect(proseTextDirection('راجع https://github.com/openchamber/openchamber/pull/6590')).toBe('rtl');
  });

  test('has no direction without letters', () => {
    expect(proseTextDirection('42 — 7 ✓')).toBeUndefined();
  });
});

describe('formatMessage isolates inserted values when directions mix', () => {
  const FSI = '⁨';
  const PDI = '⁩';
  const en = enDict;
  const ar = arDict;

  test('a right-to-left value in a left-to-right sentence', () => {
    expect(formatMessage(en, 'chat.folderMissing.text', { name: 'پوشه (2)' })).toBe(`Folder ${FSI}پوشه (2)${PDI} no longer exists`);
  });

  test('a left-to-right value in a right-to-left sentence', () => {
    expect(formatMessage(ar, 'chat.folderMissing.text', { name: 'my-folder (2)' })).toBe(`لم يعد المجلد ${FSI}my-folder (2)${PDI} موجودًا`);
  });

  test('leaves left-to-right sentences and numbers alone', () => {
    expect(formatMessage(en, 'chat.folderMissing.text', { name: 'my-folder' })).toBe('Folder my-folder no longer exists');
    expect(formatMessage(ar, 'chat.folderMissing.text', { name: 42 })).toBe('لم يعد المجلد 42 موجودًا');
    expect(formatMessage(ar, 'chat.folderMissing.text', { name: 1e-7 })).toBe('لم يعد المجلد 1e-7 موجودًا');
    expect(formatMessage(ar, 'chat.folderMissing.text', { name: true })).toBe('لم يعد المجلد true موجودًا');
  });
});
