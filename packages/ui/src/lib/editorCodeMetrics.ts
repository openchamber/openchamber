import React from 'react';

import { useDeviceInfo } from '@/lib/device';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Row height for code at the Editor font size. The editor (CodeMirror), the
 * Files view's code preview and the diffs all use it, so one setting gives
 * the same rows everywhere. Whole pixels, because the virtualized diff lays
 * rows out from this number and fractional rows drift while scrolling.
 */
export function editorCodeLineHeight(fontSize: number): number {
  // 20px rows at the default 12px.
  return Math.round(fontSize * 1.7);
}

export type EditorCodeMetrics = {
  lineHeight: number;
  /** Sizes Pierre code inside an element: `--text-code` sets the font,
   * `--oc-code-line-height` the rows (read by `diffs-container` in index.css). */
  style: React.CSSProperties;
};

/**
 * Font and row size for Pierre code views that follow the Editor font size.
 * Null on phones and tablets: mobile.css pins `--text-code` there with
 * `!important`, so those views keep their own size and default rows.
 */
export function useEditorCodeMetrics(): EditorCodeMetrics | null {
  const editorFontSize = useUIStore((state) => state.editorFontSize);
  const { isMobile, isTablet } = useDeviceInfo();
  const touchLayout = isMobile || isTablet;
  return React.useMemo(() => {
    if (touchLayout) return null;
    const lineHeight = editorCodeLineHeight(editorFontSize);
    // SAFETY: CSS custom properties are valid inline styles; React's type lists only standard ones.
    const style = {
      '--text-code': `${editorFontSize}px`,
      '--oc-code-line-height': `${lineHeight}px`,
    } as React.CSSProperties;
    return { lineHeight, style };
  }, [editorFontSize, touchLayout]);
}
