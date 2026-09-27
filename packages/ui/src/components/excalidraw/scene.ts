import type { Locale } from '@/lib/i18n';
import type { AppState } from '@excalidraw/excalidraw/types';

const EXCALIDRAW_LANG_CODE = {
  en: 'en',
  de: 'de-DE',
  es: 'es-ES',
  fr: 'fr-FR',
  ja: 'ja-JP',
  ko: 'ko-KR',
  pl: 'pl-PL',
  'pt-BR': 'pt-BR',
  tr: 'tr-TR',
  uk: 'uk-UA',
  'zh-CN': 'zh-CN',
  'zh-TW': 'zh-TW',
} satisfies Record<Locale, string>;

export const excalidrawLangCode = (locale: Locale): string => EXCALIDRAW_LANG_CODE[locale];

const DRAWING_BLOCK = /^(#{1,6}[ \t]+Drawing[^\n]*\r?\n)([^`]*)(```(?:compressed-json|json)[ \t]*\r?\n)([\s\S]*?)(\r?\n```)/m;

type ExcalidrawDrawingBlock = {
  start: number;
  end: number;
  compressed: boolean;
};

export const excalidrawDrawingBlock = (content: string): ExcalidrawDrawingBlock | null => {
  const match = DRAWING_BLOCK.exec(content);
  if (!match) return null;
  const start = match.index + match[1].length + match[2].length + match[3].length;
  return { start, end: start + match[4].length, compressed: match[3].includes('compressed-json') };
};

const isExcalidrawSceneContent = (content: string): boolean => {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed: { elements?: unknown } = JSON.parse(trimmed);
    return Array.isArray(parsed.elements);
  } catch {
    return false;
  }
};

export const isExcalidrawDocument = (content: string): boolean =>
  isExcalidrawSceneContent(content) || DRAWING_BLOCK.test(content);

export const isExcalidrawMountable = (content: string): boolean =>
  content.trim() === '' || isExcalidrawDocument(content);

export type ExcalidrawFormat = 'json' | 'obsidian';

export const excalidrawFormatForPath = (filePath: string): ExcalidrawFormat =>
  filePath.toLowerCase().endsWith('.excalidraw.md') ? 'obsidian' : 'json';

export const excalidrawSceneSignature = (
  elements: readonly { version: number; versionNonce: number }[],
  appState: Partial<AppState>,
): string => {
  let elementVersions = 0;
  for (const element of elements) {
    elementVersions = (elementVersions * 31 + element.version + element.versionNonce) | 0;
  }
  return [
    elements.length,
    elementVersions,
    appState.viewBackgroundColor ?? '',
    appState.gridModeEnabled ? 1 : 0,
    appState.gridSize ?? '',
    appState.gridStep ?? '',
  ].join(':');
};
