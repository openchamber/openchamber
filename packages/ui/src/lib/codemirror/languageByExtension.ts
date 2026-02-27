import type { Extension } from '@codemirror/state';

import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml as yamlLanguage } from '@codemirror/lang-yaml';
import { rust } from '@codemirror/lang-rust';
import { elixir } from 'codemirror-lang-elixir';
import { cpp } from '@codemirror/lang-cpp';
import { go } from '@codemirror/lang-go';

import { Language, LanguageDescription, StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { erlang } from '@codemirror/legacy-modes/mode/erlang';

const shellLanguage = StreamLanguage.define(shell);
const tomlLanguage = StreamLanguage.define(toml);
const diffLanguage = StreamLanguage.define(diff);
const dockerfileLanguage = StreamLanguage.define(dockerFile);
const rubyLanguage = StreamLanguage.define(ruby);
const propertiesLanguage = StreamLanguage.define(properties);
const elixirSupport = elixir();
const elixirLanguage = elixirSupport.language;
const erlangLanguage = StreamLanguage.define(erlang);

function codeBlockLanguageResolver(info: string): Language | LanguageDescription | null {
  const normalized = info.trim().toLowerCase();

  switch (normalized) {
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'shell':
    case 'shellsession':
    case 'console':
      return shellLanguage;
    case 'toml':
      return tomlLanguage;
    case 'diff':
    case 'patch':
      return diffLanguage;
    case 'json':
    case 'jsonc':
    case 'json5':
      return json().language;
    case 'js':
    case 'javascript':
      return javascript().language;
    case 'jsx':
      return javascript({ jsx: true }).language;
    case 'ts':
    case 'typescript':
      return javascript({ typescript: true }).language;
    case 'tsx':
      return javascript({ typescript: true, jsx: true }).language;
    case 'yaml':
    case 'yml':
      return yamlLanguage().language;
    case 'html':
      return html().language;
    case 'css':
      return css().language;
    case 'xml':
    case 'svg':
      return xml().language;
    case 'py':
    case 'python':
      return python().language;
    case 'sql':
      return sql().language;
    case 'rs':
    case 'rust':
      return rust().language;
    case 'c':
    case 'cpp':
    case 'h':
    case 'hpp':
      return cpp().language;
    case 'go':
      return go().language;
    case 'ex':
    case 'exs':
    case 'elixir':
      return elixirLanguage;
    case 'erl':
    case 'hrl':
    case 'erlang':
      return erlangLanguage;
    case 'heex':
    case 'eex':
    case 'leex':
      return html().language;
    default:
      return LanguageDescription.matchLanguageName(languages, normalized, true);
  }
}

const normalizeFileName = (filePath: string) => filePath.split('/').pop()?.toLowerCase() ?? '';

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

export function languageByExtension(filePath: string): Extension | null {
  const normalized = filePath.toLowerCase();
  const filename = normalizeFileName(normalized);

  // Special filenames
  switch (filename) {
    case 'dockerfile':
      return dockerfileLanguage;
    case 'makefile':
    case 'gnumakefile':
      // No dedicated mode; shell is a decent fallback for Make-ish files.
      return shellLanguage;
  }

  const idx = normalized.lastIndexOf('.');
  const ext = idx >= 0 ? normalized.slice(idx + 1) : '';

  switch (ext) {
    // JavaScript/TypeScript
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return javascript({ typescript: true, jsx: ext === 'tsx' });
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ typescript: false, jsx: ext === 'jsx' });

    // Web
    case 'json':
    case 'jsonc':
    case 'json5':
    case 'jsonl':
    case 'ndjson':
    case 'geojson':
      return json();
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return css();
    case 'html':
    case 'htm':
      return html();
    case 'md':
    case 'mdx':
    case 'markdown':
    case 'mdown':
    case 'mkd':
      return [
        markdown({
          codeLanguages: codeBlockLanguageResolver,
        }),
        markdownHighlight(),
      ];

    // Data/config
    case 'yml':
    case 'yaml':
      return yamlLanguage();
    case 'toml':
      return tomlLanguage;
    case 'ini':
    case 'cfg':
    case 'conf':
    case 'config':
    case 'properties':
      return propertiesLanguage;

    // Shell
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'env':
      return shellLanguage;

    // Languages we already ship
    case 'py':
    case 'pyw':
    case 'pyi':
      return python();
    case 'sql':
    case 'psql':
    case 'plsql':
      return sql();
    case 'xml':
    case 'xsl':
    case 'xslt':
    case 'xsd':
    case 'dtd':
    case 'plist':
    case 'svg':
      return xml();
    case 'rs':
      return rust();
    case 'c':
    case 'cpp':
    case 'h':
    case 'hpp':
      return cpp();
    case 'go':
      return go();

    // Legacy modes
    case 'rb':
    case 'erb':
    case 'rake':
    case 'gemspec':
      return rubyLanguage;

    case 'ex':
    case 'exs':
      return elixirSupport;
    case 'erl':
    case 'hrl':
      return erlangLanguage;

    case 'eex':
    case 'leex':
    case 'heex':
      return html();

    default:
      return null;
  }
}
