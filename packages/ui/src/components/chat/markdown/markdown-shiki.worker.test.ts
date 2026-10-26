import { afterAll, expect, test } from 'bun:test';

import { themes } from '@/lib/theme/themes';
import { getCodeTokenTheme } from '@/lib/shiki/appThemeRegistry';
import { toHexColor } from '@/lib/theme/color';
import type { MarkdownWorkerRequest, MarkdownWorkerResponse } from './markdown-worker-protocol';

const worker = new Worker(new URL('./markdown-shiki.worker.ts', import.meta.url), { type: 'module' });
afterAll(() => worker.terminate());

let nextId = 0;
const ask = (build: (id: number) => MarkdownWorkerRequest): Promise<MarkdownWorkerResponse> => {
  const request = build(++nextId);
  return new Promise((resolve) => {
    const listener = ({ data }: MessageEvent<MarkdownWorkerResponse>) => {
      if (!('id' in request) || data.id !== request.id) return;
      worker.removeEventListener('message', listener);
      resolve(data);
    };
    worker.addEventListener('message', listener);
    worker.postMessage(request);
  });
};

const theme = themes[0];
const tokenTheme = getCodeTokenTheme(theme);
const themeName = theme.metadata.id;
const comment = toHexColor(theme.colors.syntax.base.comment)?.toLowerCase();

test('editor tokens use the concrete app theme for both highlighters', async () => {
  const ts = await ask((id) => ({ type: 'highlightTokens', id, code: '// note\nconst a = 1;', lang: 'typescript', themeName, theme: tokenTheme }));
  expect(ts.type).toBe('highlightTokens');
  if (ts.type !== 'highlightTokens') return;
  expect(ts.lines).toHaveLength(2);
  expect(ts.lines[0][0]).toEqual([7, comment, 0]);

  // The theme ships once per name; ini has no Highlights lexer and goes to Shiki.
  const ini = await ask((id) => ({ type: 'highlightTokens', id, code: '; note\n[core]\nname = value', lang: 'ini', themeName }));
  expect(ini.type).toBe('highlightTokens');
  if (ini.type !== 'highlightTokens') return;
  expect(ini.lines).toHaveLength(3);
  expect(ini.lines[0].some(([, color]) => color.toLowerCase() === comment)).toBe(true);
}, 15000);

test('whole-block and per-line HTML color through the markdown variables', async () => {
  const html = await ask((id) => ({ type: 'highlight', id, code: 'const a = "x";', lang: 'typescript' }));
  expect(html.type === 'highlight' && html.html).toContain('<code><span style="color:var(--md-token-storageModifier)">const </span>');

  const lines = await ask((id) => ({ type: 'highlightLines', id, code: 'a = 1\n# note', lang: 'python' }));
  expect(lines.type).toBe('highlightLines');
  if (lines.type !== 'highlightLines') return;
  expect(lines.lines).toHaveLength(2);
  expect(lines.lines[1]).toBe('<span style="color:var(--md-syntax-comment)"># note</span>');
}, 15000);
