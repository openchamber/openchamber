import { afterAll, expect, test } from 'bun:test';
import { createMarkdownCodePlugin } from './streamdownCode';
import { streamdownCodeWorker } from './streamdownCodeWorker';
import type { HighlightResult } from 'streamdown';

afterAll(() => streamdownCodeWorker.dispose());

test('file annotations use source offsets after CRLF and Unicode', async () => {
  const code = '// 😀\r\nsrc/a.ts';
  const start = code.indexOf('src/a.ts');
  const original = await streamdownCodeWorker.highlight(code, 'typescript', false);
  const plugin = createMarkdownCodePlugin({ isVSCode: false, resolvePaths: async () => [
    { start, end: code.length, raw: 'src/a.ts', path: '/project/src/a.ts' },
  ] });
  const annotated = await new Promise<HighlightResult>((resolve) => {
    plugin.highlight({ code, language: 'typescript', themes: plugin.getThemes() }, (result) => {
      if (result.tokens.flat().some((token) => token.htmlAttrs?.['data-openchamber-file-path'])) resolve(result);
    });
  });
  const linked = annotated.tokens.flat().filter((token) => token.htmlAttrs?.['data-openchamber-file-path']);
  expect(linked.map((token) => token.content).join('')).toBe('src/a.ts');
  expect(linked[0].offset).toBe(start);
  expect(annotated.tokens[0]).toBe(original?.tokens[0]);
});

test('a warm plugin returns the cached result synchronously without redundant empty-path callbacks', async () => {
  const code = 'const cachedPlugin = "中文";';
  const highlighted = await streamdownCodeWorker.highlight(code, 'ts', false);
  const plugin = createMarkdownCodePlugin({ isVSCode: false, resolvePaths: async () => [] });
  const callbacks: HighlightResult[] = [];
  const result = plugin.highlight({ code, language: 'ts', themes: plugin.getThemes() }, (next) => callbacks.push(next));
  expect(result).toBe(highlighted!);
  await Promise.resolve();
  await Promise.resolve();
  expect(callbacks).toHaveLength(0);
});

test('annotated results are reused within one resolver and never leak into another directory', async () => {
  const code = 'src/a.ts';
  await streamdownCodeWorker.highlight(code, 'typescript', false);
  const plugin = createMarkdownCodePlugin({ isVSCode: false, resolvePaths: async () => [{ start: 0, end: code.length, raw: code, path: '/project-a/src/a.ts' }] });
  const options = { code, language: 'typescript', themes: plugin.getThemes() };
  const annotated = await new Promise<HighlightResult>((resolve) => { plugin.highlight(options, resolve); });
  expect(annotated.tokens.flat().some((token) => token.htmlAttrs?.['data-openchamber-file-path'] === '/project-a/src/a.ts')).toBe(true);
  expect(plugin.highlight(options)).toBe(annotated);
  const other = createMarkdownCodePlugin({ isVSCode: false, resolvePaths: async () => [] });
  const plain = other.highlight(options);
  expect(plain?.tokens.flat().some((token) => token.htmlAttrs?.['data-openchamber-file-path'])).toBe(false);
});

test('path resolution coalesces pending calls and can recover after rejection', async () => {
  const code = 'src/retry.ts';
  const result = await streamdownCodeWorker.highlight(code, 'typescript', false);
  let calls = 0;
  let rejectPaths: (reason: Error) => void = () => {};
  const plugin = createMarkdownCodePlugin({ isVSCode: false, resolvePaths: () => {
    calls++;
    return calls === 1 ? new Promise((_, reject) => { rejectPaths = reject; }) : Promise.resolve([]);
  } });
  const input = { code, language: 'typescript', themes: plugin.getThemes() };
  expect(plugin.highlight(input)).toBe(result!);
  expect(plugin.highlight(input)).toBe(result!);
  expect(calls).toBe(1);
  rejectPaths(new Error('Filesystem temporarily unavailable'));
  await Promise.resolve();
  await Promise.resolve();
  expect(plugin.highlight(input)).toBe(result!);
  expect(calls).toBe(2);
});
