import type { Extension } from '@codemirror/state';

import { LanguageDescription, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

type ExtensionLoader = () => Promise<Extension>;

const markdownHighlight = () => syntaxHighlighting(HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--markdown-link, currentColor)', textDecoration: 'underline' },
  { tag: t.monospace, color: 'var(--markdown-inline-code, currentColor)', backgroundColor: 'var(--markdown-inline-code-bg, transparent)' },
  { tag: t.quote, color: 'var(--markdown-blockquote, currentColor)', fontStyle: 'italic' },
  { tag: t.list, color: 'color-mix(in srgb, var(--muted-foreground) 40%, var(--foreground) 60%)' },
  { tag: t.heading, color: 'var(--markdown-heading1, currentColor)' },
]));

const normalizeFileName = (filePath: string) => filePath.split('/').pop()?.toLowerCase() ?? '';

const createMarkdownExtension = async (): Promise<Extension> => {
  const [{ markdown }, resolverModule] = await Promise.all([
    import('@codemirror/lang-markdown'),
    import('./markdownCodeLanguages'),
  ]);

  return [
    markdown({ codeLanguages: resolverModule.codeBlockLanguageResolver }),
    markdownHighlight(),
  ];
};

const loaderBySpecialFileName = new Map<string, ExtensionLoader>([
  ['dockerfile', async () => {
    const [{ StreamLanguage }, { dockerFile }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/dockerfile'),
    ]);
    return StreamLanguage.define(dockerFile);
  }],
  ['makefile', async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/shell'),
    ]);
    return StreamLanguage.define(shell);
  }],
  ['gnumakefile', async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/shell'),
    ]);
    return StreamLanguage.define(shell);
  }],
]);

const loaderByExtension = new Map<string, ExtensionLoader>([
  ['ts', async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true })],
  ['tsx', async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true })],
  ['mts', async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true })],
  ['cts', async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true })],
  ['js', async () => (await import('@codemirror/lang-javascript')).javascript()],
  ['jsx', async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true })],
  ['mjs', async () => (await import('@codemirror/lang-javascript')).javascript()],
  ['cjs', async () => (await import('@codemirror/lang-javascript')).javascript()],
  ['json', async () => (await import('@codemirror/lang-json')).json()],
  ['jsonc', async () => (await import('@codemirror/lang-json')).json()],
  ['json5', async () => (await import('@codemirror/lang-json')).json()],
  ['jsonl', async () => (await import('@codemirror/lang-json')).json()],
  ['ndjson', async () => (await import('@codemirror/lang-json')).json()],
  ['geojson', async () => (await import('@codemirror/lang-json')).json()],
  ['css', async () => (await import('@codemirror/lang-css')).css()],
  ['scss', async () => (await import('@codemirror/lang-css')).css()],
  ['sass', async () => (await import('@codemirror/lang-css')).css()],
  ['less', async () => (await import('@codemirror/lang-css')).css()],
  ['html', async () => (await import('@codemirror/lang-html')).html()],
  ['htm', async () => (await import('@codemirror/lang-html')).html()],
  ['md', createMarkdownExtension],
  ['mdx', createMarkdownExtension],
  ['markdown', createMarkdownExtension],
  ['mdown', createMarkdownExtension],
  ['mkd', createMarkdownExtension],
  ['yml', async () => (await import('@codemirror/lang-yaml')).yaml()],
  ['yaml', async () => (await import('@codemirror/lang-yaml')).yaml()],
  ['toml', async () => {
    const [{ StreamLanguage }, { toml }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/toml'),
    ]);
    return StreamLanguage.define(toml);
  }],
  ['ini', async () => {
    const [{ StreamLanguage }, { properties }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/properties'),
    ]);
    return StreamLanguage.define(properties);
  }],
  ['cfg', async () => {
    const [{ StreamLanguage }, { properties }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/properties'),
    ]);
    return StreamLanguage.define(properties);
  }],
  ['conf', async () => {
    const [{ StreamLanguage }, { properties }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/properties'),
    ]);
    return StreamLanguage.define(properties);
  }],
  ['config', async () => {
    const [{ StreamLanguage }, { properties }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/properties'),
    ]);
    return StreamLanguage.define(properties);
  }],
  ['properties', async () => {
    const [{ StreamLanguage }, { properties }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/properties'),
    ]);
    return StreamLanguage.define(properties);
  }],
  ['sh', async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/shell'),
    ]);
    return StreamLanguage.define(shell);
  }],
  ['bash', async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/shell'),
    ]);
    return StreamLanguage.define(shell);
  }],
  ['zsh', async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/shell'),
    ]);
    return StreamLanguage.define(shell);
  }],
  ['fish', async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/shell'),
    ]);
    return StreamLanguage.define(shell);
  }],
  ['env', async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/shell'),
    ]);
    return StreamLanguage.define(shell);
  }],
  ['py', async () => (await import('@codemirror/lang-python')).python()],
  ['pyw', async () => (await import('@codemirror/lang-python')).python()],
  ['pyi', async () => (await import('@codemirror/lang-python')).python()],
  ['sql', async () => (await import('@codemirror/lang-sql')).sql()],
  ['psql', async () => (await import('@codemirror/lang-sql')).sql()],
  ['plsql', async () => (await import('@codemirror/lang-sql')).sql()],
  ['xml', async () => (await import('@codemirror/lang-xml')).xml()],
  ['xsl', async () => (await import('@codemirror/lang-xml')).xml()],
  ['xslt', async () => (await import('@codemirror/lang-xml')).xml()],
  ['xsd', async () => (await import('@codemirror/lang-xml')).xml()],
  ['dtd', async () => (await import('@codemirror/lang-xml')).xml()],
  ['plist', async () => (await import('@codemirror/lang-xml')).xml()],
  ['svg', async () => (await import('@codemirror/lang-xml')).xml()],
  ['rs', async () => (await import('@codemirror/lang-rust')).rust()],
  ['c', async () => (await import('@codemirror/lang-cpp')).cpp()],
  ['cpp', async () => (await import('@codemirror/lang-cpp')).cpp()],
  ['h', async () => (await import('@codemirror/lang-cpp')).cpp()],
  ['hpp', async () => (await import('@codemirror/lang-cpp')).cpp()],
  ['go', async () => (await import('@codemirror/lang-go')).go()],
  ['rb', async () => {
    const [{ StreamLanguage }, { ruby }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/ruby'),
    ]);
    return StreamLanguage.define(ruby);
  }],
  ['erb', async () => {
    const [{ StreamLanguage }, { ruby }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/ruby'),
    ]);
    return StreamLanguage.define(ruby);
  }],
  ['rake', async () => {
    const [{ StreamLanguage }, { ruby }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/ruby'),
    ]);
    return StreamLanguage.define(ruby);
  }],
  ['gemspec', async () => {
    const [{ StreamLanguage }, { ruby }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/ruby'),
    ]);
    return StreamLanguage.define(ruby);
  }],
  ['ex', async () => (await import('codemirror-lang-elixir')).elixir()],
  ['exs', async () => (await import('codemirror-lang-elixir')).elixir()],
  ['erl', async () => {
    const [{ StreamLanguage }, { erlang }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/erlang'),
    ]);
    return StreamLanguage.define(erlang);
  }],
  ['hrl', async () => {
    const [{ StreamLanguage }, { erlang }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/erlang'),
    ]);
    return StreamLanguage.define(erlang);
  }],
  ['eex', async () => (await import('@codemirror/lang-html')).html()],
  ['leex', async () => (await import('@codemirror/lang-html')).html()],
  ['heex', async () => (await import('@codemirror/lang-html')).html()],
]);

const extensionPromiseCache = new Map<string, Promise<Extension | null>>();

function getLoader(filePath: string): ExtensionLoader | null {
  const normalized = filePath.toLowerCase();
  const filename = normalizeFileName(normalized);

  const filenameLoader = loaderBySpecialFileName.get(filename);
  if (filenameLoader) {
    return filenameLoader;
  }

  const idx = normalized.lastIndexOf('.');
  const ext = idx >= 0 ? normalized.slice(idx + 1) : '';
  return loaderByExtension.get(ext) ?? null;
}

export function languageByExtension(filePath: string): Extension | null {
  void filePath;
  return null;
}

export async function loadLanguageByExtension(filePath: string): Promise<Extension | null> {
  const loader = getLoader(filePath);
  if (!loader) {
    return null;
  }

  const cacheKey = filePath.toLowerCase();
  let promise = extensionPromiseCache.get(cacheKey);
  if (!promise) {
    promise = loader().catch(() => null);
    extensionPromiseCache.set(cacheKey, promise);
  }

  return promise;
}

export { LanguageDescription };
