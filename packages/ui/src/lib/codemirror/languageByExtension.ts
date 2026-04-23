import type { Extension } from '@codemirror/state';

// Static imports for the most common languages only.
// Less common languages are loaded dynamically via loadLanguageByExtension
// to keep the initial bundle lean.
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { python } from '@codemirror/lang-python';

import { Language, LanguageDescription, StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { shell } from '@codemirror/legacy-modes/mode/shell';

const shellLanguage = StreamLanguage.define(shell);

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
    case 'html':
      return html().language;
    case 'css':
      return css().language;
    case 'py':
    case 'python':
      return python().language;
    case 'heex':
    case 'eex':
    case 'leex':
      return html().language;
    default:
      return LanguageDescription.matchLanguageName(languages, normalized, true);
  }
}

const normalizeFileName = (filePath: string) => filePath.split('/').pop()?.toLowerCase() ?? '';

const matchLanguageDescriptionForFile = (filePath: string): LanguageDescription | null => {
  const filename = normalizeFileName(filePath);
  if (!filename) {
    return null;
  }
  return LanguageDescription.matchFilename(languages, filename);
};

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
    case 'makefile':
    case 'gnumakefile':
      // No dedicated mode; shell is a decent fallback for Make-ish files.
      return shellLanguage;
  }

  const idx = normalized.lastIndexOf('.');
  const ext = idx >= 0 ? normalized.slice(idx + 1) : '';

  switch (ext) {
    // JavaScript/TypeScript (most common — keep static)
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

    // Web (keep static)
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

    // Shell (keep static)
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'env':
      return shellLanguage;

    // Python (very common — keep static)
    case 'py':
    case 'pyw':
    case 'pyi':
      return python();

    // Less common languages: return null so callers fall back to
    // loadLanguageByExtension which dynamically imports from @codemirror/language-data.
    default:
      return null;
  }
}

export async function loadLanguageByExtension(filePath: string): Promise<Extension | null> {
  const description = matchLanguageDescriptionForFile(filePath);
  if (!description) {
    return null;
  }

  if (description.support) {
    return description.support;
  }

  try {
    return await description.load();
  } catch {
    return null;
  }
}
