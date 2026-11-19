import { describe, expect, test } from 'vitest';
import { transformWithEsbuild } from 'vite';

import { escapeRegexLiterals, escapeRemainingWide } from './vite-one-byte-chunks';
import { dictionaryLocale, localeSliceId, sliceLocale } from './vite-locale-slices';
import { chunkHasModule, preloadScript, staticImportClosure } from './vite-preload-app-graph';
import { appStoreModules, shareDocumentShim } from './vite-share-document';

const evaluate = (expression: string) => new Function(`return ${expression}`)();
const WIDE = /[Ā-\u{10FFFF}]/u;

describe('escapeRemainingWide', () => {
  const sameRegExp = (literal: string) => {
    const escaped = escapeRemainingWide(literal);
    expect(WIDE.test(escaped)).toBe(false);
    return [evaluate(literal), evaluate(escaped)];
  };

  test('a regular expression keeps its meaning', () => {
    const [before, after] = sameRegExp(String.raw`/^[.,;:!?…)\]}»”’"'%]+/`);
    for (const input of ['…rest', '”x', 'plain', ']end']) expect(after.test(input)).toBe(before.test(input));
  });

  test('an escaped character loses only its own backslash', () => {
    const [before, after] = sameRegExp(String.raw`/a\…b/`);
    expect(after.test('a…b')).toBe(true);
    expect(after.source).not.toContain('\\\\');
    expect(before.test('a…b')).toBe(true);
    const [, doubled] = sameRegExp(String.raw`/a\\…/`);
    expect(doubled.test('a\\…')).toBe(true);
  });

  test('an astral character becomes its surrogate pair, with and without the u flag', () => {
    const [, plain] = sameRegExp('/😀+/');
    const [, unicode] = sameRegExp('/[😀]/u');
    expect(plain.test('😀😀')).toBe(true);
    expect(unicode.test('😀')).toBe(true);
  });
});

describe('escapeRegexLiterals after esbuild ASCII', () => {
  const reprint = async (code: string) => escapeRegexLiterals((await transformWithEsbuild(code, 'chunk.js', {
    loader: 'js', charset: 'ascii', minifyWhitespace: true, legalComments: 'none',
  })).code);

  test('a chunk whose only wide characters are in strings and regexes becomes ASCII and behaves the same', async () => {
    const out = await reprint('export const a = "…"; export const r = /[…→]/u; export const t = `x→${a}`;');
    expect(out).not.toBeNull();
    expect(/[\u0080-\u{10FFFF}]/u.test(out ?? '')).toBe(false);
    const module = await import(`data:text/javascript,${encodeURIComponent(out ?? '')}`);
    expect(module.a).toBe('…');
    expect(module.r.test('→')).toBe(true);
    expect(module.t).toBe('x→…');
  });

  test('a tagged template keeps its raw text: the chunk is left as it was', async () => {
    expect(await reprint('export const s = String.raw`…`;')).toBeNull();
  });
});

describe('locale slices', () => {
  const feature = `export const routingI18n = {
  en: { 'a': 'Auto' },
  uk: { 'a': 'Авто' },
  'zh-CN': { 'a': '自动' },
};`;
  const featureId = '/repo/packages/ui/src/lib/i18n/messages/routing.i18n.ts';

  test('a locale dictionary gets only its own locale', () => {
    expect(sliceLocale(feature, `${featureId}?i18n-locale=uk`)).toContain("export const routingI18n = {uk: { 'a': 'Авто' }}");
  });

  test('a quoted locale key is matched', () => {
    const sliced = sliceLocale(feature, `${featureId}?i18n-locale=zh-CN`);
    expect(sliced).toContain('自动');
    expect(sliced).not.toContain('Авто');
  });

  test('a module of another shape and one without the query are left whole', () => {
    expect(sliceLocale('export const a = { en: {} };\nexport const b = 1;', `${featureId}?i18n-locale=uk`)).toBeNull();
    expect(sliceLocale('export const a = { ...base, uk: {} };', `${featureId}?i18n-locale=uk`)).toBeNull();
    expect(sliceLocale(feature, featureId)).toBeNull();
  });

  test('only imports of a feature file from a locale dictionary are redirected', () => {
    expect(dictionaryLocale('/x/i18n/messages/pt-BR.settings.ts')).toBe('pt-BR');
    expect(dictionaryLocale('/x/i18n/messages/uk.ts')).toBe('uk');
    expect(dictionaryLocale('/x/components/Panel.tsx')).toBeNull();
    expect(localeSliceId(featureId, 'uk')).toBe(`${featureId}?i18n-locale=uk`);
    expect(localeSliceId('/x/i18n/messages/en.ts', 'uk')).toBeNull();
  });
});

describe('preloadAppGraph', () => {
  const chunk = (imports: string[], dynamicImports: string[] = []) => ({ type: 'chunk' as const, imports, dynamicImports });

  test('the closure follows static imports once and stops at dynamic ones', () => {
    const bundle = {
      'app.js': chunk(['a.js', 'b.js'], ['lazy.js']),
      'a.js': chunk(['b.js']),
      'b.js': chunk(['a.js']),
      'lazy.js': chunk([]),
      'style.css': { type: 'asset' as const },
    };
    expect(staticImportClosure(bundle, 'app.js')).toEqual(['app.js', 'a.js', 'b.js']);
  });

  test('links are added only on a listed protocol', () => {
    const run = (protocol: string) => {
      const added: Array<{ rel: string; href: string }> = [];
      const document = { createElement: () => ({}), head: { appendChild: (link: { rel: string; href: string }) => added.push(link) } };
      new Function('location', 'document', preloadScript(['/assets/app.js'], ['openchamber-ui:']))({ protocol }, document);
      return added.map((link) => `${link.rel} ${link.href}`);
    };
    expect(run('openchamber-ui:')).toEqual(['modulepreload /assets/app.js']);
    expect(run('https:')).toEqual([]);
  });

  test('a Windows path finds the module Rollup keys with forward slashes', () => {
    const modules = { 'D:/a/openchamber/packages/ui/src/main.tsx': {} };
    expect(chunkHasModule(modules, 'D:\\a\\openchamber\\packages\\ui\\src\\main.tsx')).toBe(true);
    expect(chunkHasModule(modules, 'D:\\a\\openchamber\\packages\\ui\\src\\other.tsx')).toBe(false);
    expect(chunkHasModule({ '/repo/packages/ui/src/main.tsx': {} }, '/repo/packages/ui/src/main.tsx')).toBe(true);
  });
});

describe('appStoreModules', () => {
  test('finds app stores in the share document bundle, and nothing else', () => {
    const ids = [
      '/repo/packages/ui/src/share-document/shims/ui-store.ts',
      '/repo/packages/ui/src/stores/useConfigStore.ts',
      '/repo/packages/ui/src/storesExtra/x.ts',
      '/repo/node_modules/zustand/esm/index.mjs',
    ];
    expect(appStoreModules(ids, '/repo/packages/ui/src')).toEqual(['/repo/packages/ui/src/stores/useConfigStore.ts']);
  });

  test('matches Windows paths whichever separator each side uses', () => {
    expect(appStoreModules(['D:/a/packages/ui/src/stores/useUIStore.ts'], 'D:\\a\\packages\\ui\\src')).toHaveLength(1);
  });
});

describe('shareDocumentShim', () => {
  test('a shimmed module resolves to its shim, any other module is left alone', () => {
    expect(shareDocumentShim('/repo/packages/ui/src/stores/useUIStore.ts?v=1', '/repo/packages/ui/src')).toBe('/repo/packages/ui/src/share-document/shims/ui-store.ts');
    expect(shareDocumentShim('/repo/packages/ui/src/stores/useConfigStore.ts', '/repo/packages/ui/src')).toBeNull();
  });

  test('a Windows source folder matches the forward-slash id Vite resolves to', () => {
    expect(shareDocumentShim('D:/a/packages/ui/src/lib/desktop.ts', 'D:\\a\\packages\\ui\\src', true)).toBe('D:/a/packages/ui/src/share-document/shims/desktop.ts');
  });

  test('a backslash in a folder name outside Windows stays part of the name', () => {
    expect(shareDocumentShim('/re\\po/src/lib/desktop.ts', '/re\\po/src', false)).toBe('/re\\po/src/share-document/shims/desktop.ts');
  });
});
