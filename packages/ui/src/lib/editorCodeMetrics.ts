import React from 'react';

import { useDeviceInfo } from '@/lib/device';
import { useUIStore } from '@/stores/useUIStore';

export function editorCodeLineHeight(fontSize: number): number {
  return Math.round(fontSize * 1.7);
}

export type EditorCodeMetrics = {
  lineHeight: number;
  style: React.CSSProperties;
};

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
