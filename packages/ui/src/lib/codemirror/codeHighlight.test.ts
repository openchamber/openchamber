import { afterAll, afterEach, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { codeToTokens } from '@pierre/highlights';

import { getCodeTokenTheme } from '@/lib/shiki/appThemeRegistry';
import { themes } from '@/lib/theme/themes';

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'code-highlight-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  MutationObserver: dom.MutationObserver,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});

const { EditorView } = await import('@codemirror/view');
const { codeHighlightExtension } = await import('./codeHighlight');

const theme = getCodeTokenTheme(themes[0]);
const views: InstanceType<typeof EditorView>[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});
afterAll(() => dom.happyDOM.close());

/** The color each character is painted with, per line. */
const paintedColors = (view: InstanceType<typeof EditorView>): string[][] =>
  Array.from(view.contentDOM.querySelectorAll('.cm-line'), (line) => {
    const colors: string[] = [];
    const walk = (node: Node, color: string) => {
      if (node.nodeType === 3) {
        for (let i = 0; i < (node.textContent ?? '').length; i += 1) colors.push(color);
        return;
      }
      const style = node instanceof HTMLElement ? node.getAttribute('style') ?? '' : '';
      const own = /color:\s*([^;]+)/.exec(style)?.[1] ?? color;
      node.childNodes.forEach((child) => walk(child, own));
    };
    walk(line, '');
    return colors;
  });

/** What one full pass over the document would paint. */
const expectedColors = (code: string): string[][] =>
  codeToTokens(code, { lang: 'typescript', theme: theme.zed }).tokens.map((line) =>
    line.flatMap((token) => Array.from({ length: token.content.length }, () => token.color ?? '')));

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('incremental colors match a full pass after typing and multi-range edits', async () => {
  const view = new EditorView({
    doc: 'const a = 1;\nlet b = "x";\n',
    extensions: [codeHighlightExtension({ language: 'typescript', themeName: themes[0].metadata.id, theme })],
    parent: document.body,
  });
  views.push(view);
  await settle();
  expect(paintedColors(view)).toEqual(expectedColors(view.state.doc.toString()));
  expect(paintedColors(view)[0].some(Boolean)).toBe(true);

  // An unterminated comment recolors every line below it.
  view.dispatch({ changes: { from: 0, insert: '/* ' } });
  expect(paintedColors(view)).toEqual(expectedColors(view.state.doc.toString()));

  view.dispatch({ changes: [{ from: 0, to: 3 }, { from: view.state.doc.length, insert: '// end\nconst c = `t`;' }] });
  expect(paintedColors(view)).toEqual(expectedColors(view.state.doc.toString()));
});
