import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { HighlightResult } from 'streamdown';
import { MarkdownContent } from '../MarkdownRendererImpl';
import { prepareExportHighlight } from './streamdownCode';
import { I18nProvider } from '@/lib/i18n';
import { normalizeMarkdownCopyContent } from './selectionMarkdown';

/** Offline rendering shares the screen parser, policies and components. */
export async function renderMarkdownForExport(text: string, options: { purpose: 'copy' | 'image'; syntaxStyle?: string | null }): Promise<HTMLElement> {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset-inline-start:-100000px;top:0;width:720px;visibility:hidden;pointer-events:none';
  if (options.syntaxStyle) host.style.cssText += `;${options.syntaxStyle}`;
  document.body.append(host);
  const root = createRoot(host);
  const sources = new Map<string, Set<string>>();
  const collect = (source: string, language: string) => {
    let texts = sources.get(language);
    if (!texts) { texts = new Set(); sources.set(language, texts); }
    texts.add(source.replace(/\n$/, ''));
  };
  const draw = (preparedHighlights?: ReadonlyMap<string, ReadonlyMap<string, HighlightResult>>) => flushSync(() => root.render(
    <I18nProvider><MarkdownContent content={text} purpose={options.purpose} enableFileReferences={false} onExportCode={collect} preparedHighlights={preparedHighlights} /></I18nProvider>,
  ));
  try {
    draw();
    if (options.purpose === 'image' && sources.size) {
      const prepared = new Map(await Promise.all([...sources].map(async ([language, texts]) => [language, new Map(await Promise.all([...texts].map(async (source) => [source, await prepareExportHighlight(source, language)] as const)))] as const)));
      draw(prepared);
    }
    const content = host.querySelector<HTMLElement>('[data-markdown-content]');
    if (!content) throw new Error('Markdown export did not produce content');
    const clone = content.cloneNode(true);
    if (!(clone instanceof HTMLElement)) throw new Error('Markdown export root is invalid');
    if (options.purpose === 'copy') normalizeMarkdownCopyContent(clone);
    if (options.syntaxStyle) clone.style.cssText += `;${options.syntaxStyle}`;
    return clone;
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
}
