import { findOpenGuestFileEditor } from '@/lib/guests/file-editors';

export const isMarkdownFile = (path: string): boolean => {
  if (!path) return false;
  const lower = path.toLowerCase();
  if (lower.endsWith('.excalidraw.md')) return false;
  const ext = lower.split('.').pop();
  return ext === 'md' || ext === 'markdown';
};

export const opensInFileCanvas = (path: string | null | undefined): boolean => Boolean(
  path && findOpenGuestFileEditor(path),
);

export const isJsonFile = (path: string): boolean => {
  if (!path) return false;
  const ext = path.toLowerCase().split('.').pop();
  return ext === 'json' || ext === 'jsonc' || ext === 'json5' || ext === 'geojson';
};

export const isHtmlFile = (path: string): boolean => {
  if (!path) return false;
  const ext = path.toLowerCase().split('.').pop();
  return ext === 'html' || ext === 'htm';
};
