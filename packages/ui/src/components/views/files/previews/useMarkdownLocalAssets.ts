import React from 'react';
import type { MarkdownDocumentAssets } from '@/components/chat/markdown/MarkdownMediaContext';
import { toAbsoluteFilePath } from '@/lib/path-utils';

export const isMarkdownDocumentReference = (value: string): boolean => (
  Boolean(value.trim()) && !value.startsWith('#') && !value.startsWith('//')
  && !/^[a-z][a-z\d+.-]*:/i.test(value)
);

const decodeReference = (value: string): string => {
  try { return decodeURIComponent(value); } catch { return value; }
};

export const resolveMarkdownDocumentReference = (filePath: string, reference: string): string => (
  toAbsoluteFilePath(filePath.slice(0, filePath.lastIndexOf('/') + 1) || '/', decodeReference(reference.split(/[?#]/, 1)[0] ?? ''))
);

/** Called by the React link owner, before application/external navigation. */
export const openMarkdownDocumentLink = (
  event: React.MouseEvent<HTMLAnchorElement>,
  assets: MarkdownDocumentAssets | undefined,
): boolean => {
  if (!assets || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const href = event.currentTarget.getAttribute('href') ?? '';
  if (href.startsWith('#')) {
    event.preventDefault();
    event.stopPropagation();
    const wanted = decodeReference(href.slice(1)).toLowerCase();
    const container = event.currentTarget.closest('[data-markdown-content]');
    for (const heading of container?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6') ?? []) {
      const slug = (heading.textContent ?? '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
      if (wanted && (heading.id === wanted || slug === wanted)) {
        heading.scrollIntoView({ block: 'start' });
        break;
      }
    }
    return true;
  }
  if (!isMarkdownDocumentReference(href)) return false;
  event.preventDefault();
  event.stopPropagation();
  assets.onOpenFile(resolveMarkdownDocumentReference(assets.filePath, href));
  return true;
};

/** Supplies document ownership before React renders media and links. */
export const useMarkdownLocalAssets = ({ filePath, workspaceRoot, onOpenFile, enabled, colorScheme }: {
  filePath: string | null;
  workspaceRoot: string | null;
  onOpenFile: (absolutePath: string) => void;
  enabled: boolean;
  colorScheme: 'light' | 'dark';
}): MarkdownDocumentAssets | undefined => React.useMemo(
  () => enabled && filePath ? { filePath, workspaceRoot, onOpenFile, colorScheme } : undefined,
  [enabled, filePath, workspaceRoot, onOpenFile, colorScheme],
);
