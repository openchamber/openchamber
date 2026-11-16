import React from 'react';
import type { Theme } from '@/types/theme';
import type { ToolPopupContent } from '../message/types';
import type { MarkdownCodePlugin } from './streamdownCode';
import type { GuestLinkRule } from '@/lib/guests/links';

export type FileReferenceSource = 'path' | 'href';

export interface MermaidControls {
  download?: boolean;
  copy?: boolean;
  showPanZoomControls?: boolean;
  /** A header of the surface around the diagram (the full-screen viewer) that takes the controls instead of a row above. */
  toolbarSlot?: HTMLElement | null;
}

export interface MarkdownPresentation {
  directory: string;
  fileReferences: boolean;
  fileNavigation: boolean;
  /** The text no longer changes: tables may measure their columns. */
  settled: boolean;
  /** A preview button next to loopback links; only chat messages show it. */
  loopbackPreview: boolean;
  purpose?: 'copy' | 'image';
  /** `openui-lang` fences draw as UI blocks (`components/chat/uiBlocks`). */
  uiBlocks: boolean;
  /** `svg` fences draw as images (`MarkdownSvg`); only the Files preview sets it. */
  svgFences: boolean;
  /** The finished reply a UI block answers and a command block runs from; absent while it streams, and outside chat replies. */
  settledReply: { sessionId: string; messageId: string } | null;
  disableLinkSafety?: boolean;
  /** What active extensions claim in this chat message; null outside chat messages and in copies. */
  guestLinks: readonly GuestLinkRule[] | null;
  /** Names the document whose tables keep the column widths the user sets; absent, columns have no grips. */
  tableWidthScope?: string;
  theme: Theme;
  mermaidControls: MermaidControls;
  onShowPopup?: (content: ToolPopupContent) => void;
  onExportCode?: (source: string, language: string) => void;
  confirmFile: (source: string, inputKind?: FileReferenceSource) => Promise<string | null>;
  code: MarkdownCodePlugin;
}

/**
 * Set by `MarkdownCode` around a drawn `svg` fence. Called when the browser
 * cannot draw the source, so the fence goes back to the ordinary code block.
 */
export const MarkdownSvgFailureContext = React.createContext<(() => void) | null>(null);

export const MarkdownPresentationContext = React.createContext<MarkdownPresentation | null>(null);
export function useMarkdownPresentation(): MarkdownPresentation {
  const value = React.useContext(MarkdownPresentationContext);
  if (!value) throw new Error('Markdown components require MarkdownContent');
  return value;
}
