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

/**
 * Whether the Files view mounts the canvas. This is the guard that keeps a
 * blank canvas from being serialized over a real drawing: a draft the canvas
 * cannot read stays in the source editor. `previewReady` covers the frame the
 * view waits for before remounting on a source-to-canvas toggle.
 */
export const shouldShowExcalidrawCanvas = (input: {
  isExcalidraw: boolean;
  viewMode: 'preview' | 'edit';
  previewReady: boolean;
  draft: string;
}): boolean => input.isExcalidraw && input.viewMode === 'preview' && input.previewReady && isExcalidrawMountable(input.draft);

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

/**
 * Tracks whether the canvas differs from what was last written. Saving takes
 * one snapshot and marks that snapshot's signature saved after the write, so
 * strokes drawn while the write ran leave the canvas dirty instead of being
 * recorded as saved but never written.
 */
export const createExcalidrawSaveTracker = (initialSignature: string | null) => {
  let saved = initialSignature;
  let live = initialSignature;
  return {
    /** A new live scene; `edited` is true when the drawing itself changed. */
    observe: (signature: string): { edited: boolean; dirty: boolean } => {
      const edited = signature !== live;
      live = signature;
      return { edited, dirty: signature !== saved };
    },
    /** Records a written snapshot; returns whether the live scene is still dirty. */
    markSaved: (signature: string): boolean => {
      saved = signature;
      return live !== signature;
    },
  };
};

