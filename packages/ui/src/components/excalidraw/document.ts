import { restore, serializeAsJSON } from '@excalidraw/excalidraw';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ImportedDataState } from '@excalidraw/excalidraw/data/types';
import { compressToBase64, decompressFromBase64 } from 'lz-string';

import { excalidrawDrawingBlock, type ExcalidrawFormat } from './scene';

type ExcalidrawSceneDocument = {
  elements: readonly OrderedExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

type ExcalidrawContainer =
  | { kind: 'json' }
  | { kind: 'drawing'; content: string; start: number; end: number; compressed: boolean };

type ExcalidrawDocument = {
  scene: ExcalidrawSceneDocument;
  container: ExcalidrawContainer;
};

const PAYLOAD_CHUNK = 256;

const encodePayload = (json: string, compressed: boolean): string => {
  if (!compressed) return json;
  const encoded = compressToBase64(json);
  const chunks: string[] = [];
  for (let index = 0; index < encoded.length; index += PAYLOAD_CHUNK) {
    chunks.push(encoded.slice(index, index + PAYLOAD_CHUNK));
  }
  return chunks.join('\n\n');
};

const decodePayload = (payload: string, compressed: boolean): string | null => {
  if (!compressed) return payload;
  return decompressFromBase64(payload.replace(/[\n\r]/g, '')) || null;
};

const parseSceneState = (json: string): ImportedDataState | null => {
  try {
    const parsed: ImportedDataState = JSON.parse(json);
    return Array.isArray(parsed.elements) ? parsed : null;
  } catch {
    return null;
  }
};

const restoreScene = (parsed: ImportedDataState): ExcalidrawSceneDocument => {
  const restored = restore(parsed, null, null, { repairBindings: true });
  return { elements: restored.elements, appState: restored.appState, files: restored.files };
};

const NEW_OBSIDIAN_PREFIX = '---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n\n# Excalidraw Data\n\n## Text Elements\n\n## Drawing\n```compressed-json\n';
const NEW_OBSIDIAN_SUFFIX = '\n```\n%%\n';

const newObsidianContainer = (): ExcalidrawContainer => ({
  kind: 'drawing',
  content: NEW_OBSIDIAN_PREFIX + NEW_OBSIDIAN_SUFFIX,
  start: NEW_OBSIDIAN_PREFIX.length,
  end: NEW_OBSIDIAN_PREFIX.length,
  compressed: true,
});

export const parseExcalidrawDocument = (content: string): ExcalidrawDocument | null => {
  const block = excalidrawDrawingBlock(content);
  let json: string;
  let container: ExcalidrawContainer;
  if (block) {
    const decoded = decodePayload(content.slice(block.start, block.end), block.compressed);
    if (decoded === null) return null;
    json = decoded;
    container = { kind: 'drawing', content, start: block.start, end: block.end, compressed: block.compressed };
  } else {
    json = content;
    container = { kind: 'json' };
  }

  const parsed = parseSceneState(json);
  if (!parsed) return null;

  try {
    return { scene: restoreScene(parsed), container };
  } catch {
    return null;
  }
};

export const openExcalidrawDocument = (
  content: string,
  format: ExcalidrawFormat,
): ExcalidrawDocument | null => {
  if (content.trim() !== '') return parseExcalidrawDocument(content);
  try {
    const scene = restoreScene({ elements: [], appState: {}, files: {} });
    return {
      scene,
      container: format === 'obsidian' ? newObsidianContainer() : { kind: 'json' },
    };
  } catch {
    return null;
  }
};

export const serializeExcalidrawDocument = (
  container: ExcalidrawContainer,
  scene: ExcalidrawSceneDocument,
): string => {
  const json = serializeAsJSON(scene.elements, scene.appState, scene.files, 'local');
  if (container.kind === 'json') return json;
  return container.content.slice(0, container.start)
    + encodePayload(json, container.compressed)
    + container.content.slice(container.end);
};
