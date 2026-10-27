import React from 'react';
import type { Element } from 'hast';
import { parseMarkdownIntoBlocks, type BlockProps } from 'streamdown';
import type { OpenUIOwner } from '../openui/openuiHost';
import { collectOpenUIFences, normalizeOpenUISource, type OpenUIFence } from './openuiFences';

export interface OpenUIFenceMount {
  owner: OpenUIOwner;
  fence: OpenUIFence;
  canonical: string;
  isStreaming: boolean;
  canInteract: () => boolean;
}

interface DisplaySource {
  displayed: string;
  fences: readonly OpenUIFence[];
  receipt: {
    processed: string;
    fences: readonly OpenUIFence[];
    blocks: Array<{ content: string; start: number }>;
    matchingPrefix: number;
  };
  split: (processed: string) => string[];
}

/** Original displayed text and its already parsed fence positions. */
export interface OpenUIAnalyzedSource {
  source: string;
  fences: readonly OpenUIFence[];
}

interface DocumentSource {
  display: DisplaySource;
  canonical: string;
  canonicalFences: readonly OpenUIFence[];
  fullCanonical: string;
  fullRaw: string;
  offset: number;
  validRange: boolean;
  isStreaming: boolean;
  finalized: boolean;
  owner: OpenUIOwner;
  currentSource: () => string | null;
  matchingPrefix: number;
}

export const OpenUIDocumentContext = React.createContext<DocumentSource | null>(null);
export const OpenUIBlockContext = React.createContext<Pick<BlockProps, 'content' | 'index'> | null>(null);
export const OpenUIFenceContext = React.createContext<OpenUIFenceMount | null>(null);

function matchingPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index++;
  return index;
}

/** Display receipts survive canonical updates that Streamdown's memo skips. */
function createOpenUIDisplay(source: string, analyzed?: OpenUIAnalyzedSource): DisplaySource {
  const displayed = normalizeOpenUISource(source);
  const fences = analyzed?.source === displayed ? analyzed.fences : collectOpenUIFences(displayed);
  const display: DisplaySource = {
    displayed, fences,
    receipt: { processed: displayed, fences, blocks: [], matchingPrefix: displayed.length },
    split: (processed) => {
      const normalized = normalizeOpenUISource(processed);
      const blocks = parseMarkdownIntoBlocks(processed);
      let start = 0;
      const positions = blocks.join('') === normalized ? blocks.map((content) => {
        const block = { content, start };
        start += content.length;
        return block;
      }) : [];
      display.receipt = {
        processed: normalized,
        fences: normalized === displayed ? fences : collectOpenUIFences(normalized),
        blocks: positions,
        matchingPrefix: matchingPrefix(normalized, displayed),
      };
      return blocks;
    },
  };
  return display;
}

/** Keep the processed receipt when only upstream analysis or authority changes. */
export function useOpenUIDisplay(source: string | null, analyzed?: OpenUIAnalyzedSource) {
  const [retained, setRetained] = React.useState<{ source: string; display: DisplaySource } | null>(null);
  if (source === null) return null;
  if (retained?.source === source) return retained.display;
  const display = createOpenUIDisplay(source, analyzed);
  setRetained({ source, display });
  return display;
}

export function createOpenUIDocument(input: {
  displayed: string | DisplaySource;
  canonical: string;
  fullSource?: string;
  range?: { start: number; end?: number };
  owner: OpenUIOwner;
  currentSource: () => string | null;
  isStreaming?: boolean;
  finalized?: boolean;
}) {
  const display = typeof input.displayed === 'string' ? createOpenUIDisplay(input.displayed) : input.displayed;
  const canonical = normalizeOpenUISource(input.canonical);
  const fullSource = input.fullSource ?? input.canonical;
  const offset = input.range ? normalizeOpenUISource(fullSource.slice(0, input.range.start)).length : 0;
  const document: DocumentSource = {
    ...input,
    display,
    canonical,
    fullCanonical: normalizeOpenUISource(fullSource),
    fullRaw: fullSource,
    offset,
    validRange: !input.range || fullSource.slice(input.range.start, input.range.end) === input.canonical,
    matchingPrefix: matchingPrefix(display.displayed, canonical),
    canonicalFences: canonical === display.displayed ? display.fences : collectOpenUIFences(canonical),
    isStreaming: input.isStreaming ?? false,
    finalized: input.finalized ?? !input.isStreaming,
  };
  return { document, split: display.split };
}

/** Display offsets authorize nothing until they match a genuine canonical fence. */
export function useOpenUIFence(node: Element | undefined, code: string): OpenUIFenceMount | null {
  const document = React.useContext(OpenUIDocumentContext);
  const block = React.useContext(OpenUIBlockContext);
  if (!document || !document.validRange || !node?.position) return null;
  const display = document.display;
  const receipt = display.receipt;
  const localStart = node.position.start.offset;
  const localEnd = node.position.end.offset;
  if (localStart === undefined || localEnd === undefined) return null;
  const slice = block ? receipt.blocks[block.index] : null;
  if (block && (!slice || slice.content !== block.content)) return null;
  const base = slice?.start ?? 0;
  const start = base + localStart;
  const end = base + localEnd;
  // Only the unchanged display prefix can prove a processed node's origin.
  if (end > receipt.matchingPrefix) return null;
  const processedFence = receipt.fences.find((item) => item.start === start && item.end === end);
  if (!processedFence || `${processedFence.code}\n` !== code) return null;
  const fence = display.fences.find((item) => item.start === start);
  if (!fence || fence.literal || fence.meta || fence.end > document.matchingPrefix) return null;
  // Remend can shorten its EOF, including whitespace on a closing line. The
  // unchanged processed prefix must end inside the original fence span.
  if (fence.end !== end && (end !== receipt.processed.length || fence.end < end)) return null;
  const canonical = document.canonicalFences.find((item) => item.start === start);
  if (!canonical || canonical.literal || canonical.meta || canonical.end < fence.end) return null;
  const complete = fence.closed && canonical.closed && canonical.code === fence.code
    && (document.canonical.charAt(canonical.end) === '\n' || document.finalized);
  if (!complete && !document.isStreaming) return null;
  return {
    owner: document.owner,
    canonical: document.fullRaw,
    fence: { ...fence, start: fence.start + document.offset, end: fence.end + document.offset },
    isStreaming: !complete,
    canInteract: () => {
      if (!complete) return false;
      const current = document.currentSource();
      if (current === null) return false;
      const normalized = normalizeOpenUISource(current);
      if (normalized === document.fullCanonical) return true;
      if (!normalized.startsWith(document.fullCanonical)) return false;
      // Appending to a closing marker's line can revoke its closure.
      const end = canonical.end + document.offset;
      return document.fullCanonical.charAt(end) === '\n' || normalized.charAt(end) === '\n';
    },
  };
}
