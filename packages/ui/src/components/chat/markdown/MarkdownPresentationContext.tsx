import React from 'react';
import type { Theme } from '@/types/theme';
import type { ToolPopupContent } from '../message/types';
import type { MarkdownCodePlugin } from './streamdownCode';

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
  disableLinkSafety?: boolean;
  theme: Theme;
  mermaidControls: MermaidControls;
  allowMermaidWheelEvents?: boolean;
  onShowPopup?: (content: ToolPopupContent) => void;
  onExportCode?: (source: string, language: string) => void;
  confirmFile: (source: string, inputKind?: FileReferenceSource) => Promise<string | null>;
  code: MarkdownCodePlugin;
}

export const MarkdownPresentationContext = React.createContext<MarkdownPresentation | null>(null);
export function useMarkdownPresentation(): MarkdownPresentation {
  const value = React.useContext(MarkdownPresentationContext);
  if (!value) throw new Error('Markdown components require MarkdownContent');
  return value;
}
