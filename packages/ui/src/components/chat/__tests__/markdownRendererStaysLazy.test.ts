/**
 * Regression guard: the Markdown renderer stays out of the startup bundle.
 *
 * `MarkdownRendererImpl` brings Streamdown, KaTeX, Shiki and beautiful-mermaid
 * with ELK, about 3 MB of script. `markdownRendererLoader` imports it
 * dynamically so the first screen does not wait for it, but one static value
 * import from a module of the startup graph puts all of it back into that
 * graph, and the build only says so in a warning among dozens. Components
 * reach it through `MarkdownRenderer.tsx`; type imports are free.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return sourceFiles(path);
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
});

// One import or re-export statement at a time, type-only ones skipped.
const STATIC_STATEMENT = /^\s*(?:import|export)\s+(?!type\s)(?:[^'"]*?\bfrom\s*)?['"]([^'"]+)['"]/gm;

/** Whether `source` statically imports or re-exports values of `module`. */
const importsValuesOf = (source: string, module: string): boolean => {
  const specifier = new RegExp(`(?:^|/)${module}(?:\\.[cm]?[jt]sx?)?$`);
  return [...source.matchAll(STATIC_STATEMENT)].some((match) => specifier.test(match[1]));
};

const staticValueImporters = (module: string): string[] => sourceFiles(srcRoot)
  .filter((path) => importsValuesOf(readFileSync(path, 'utf-8'), module))
  .map((path) => relative(srcRoot, path).split(sep).join('/'));

describe('the Markdown renderer stays out of the startup bundle', () => {
  test('only the on-demand export path imports MarkdownRendererImpl statically', () => {
    expect(staticValueImporters('MarkdownRendererImpl')).toEqual(['components/chat/markdown/renderMarkdownForExport.tsx']);
  });

  test('the export path itself is only imported on demand', () => {
    expect(staticValueImporters('renderMarkdownForExport')).toEqual([]);
  });

  test('the matcher sees every static form and skips type-only imports', () => {
    const module = 'MarkdownRendererImpl';
    for (const source of [
      "import { MarkdownContent } from '../MarkdownRendererImpl';",
      "import { MarkdownContent } from '../MarkdownRendererImpl.tsx';",
      "import {\n  MarkdownContent,\n  MarkdownRenderer,\n} from './MarkdownRendererImpl'",
      "import { type MarkdownVariant } from './MarkdownRendererImpl';",
      "export { MarkdownContent } from './MarkdownRendererImpl';",
      "export * from './MarkdownRendererImpl';",
      "import './MarkdownRendererImpl';",
    ]) expect(importsValuesOf(source, module)).toBe(true);
    for (const source of [
      "import type { MarkdownVariant } from './MarkdownRendererImpl';",
      "import React from 'react'\nimport type { MarkdownVariant } from './MarkdownRendererImpl'",
      "const load = () => import('./MarkdownRendererImpl');",
      "import { MarkdownRenderer } from './MarkdownRenderer';",
    ]) expect(importsValuesOf(source, module)).toBe(false);
  });
});
