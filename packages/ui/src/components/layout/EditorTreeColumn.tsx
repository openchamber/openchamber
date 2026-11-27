import React from 'react';

import { isRightToLeft, useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useWindowPointerRelease } from '@/hooks/useWindowPointerRelease';
import { clampContextEditorTreeWidth, useUIStore } from '@/stores/useUIStore';

export const EditorTreeColumn: React.FC<{
  visible: boolean;
  fill?: boolean;
  stretch?: boolean;
  side: 'left' | 'right';
  children: React.ReactNode;
}> = ({ visible, fill = false, stretch = false, side, children }) => {
  const { t } = useI18n();
  const width = useUIStore((state) => state.contextEditorTreeWidth);
  const setWidth = useUIStore((state) => state.setContextEditorTreeWidth);
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const liveWidthRef = React.useRef<number | null>(null);
  const pointerIDRef = React.useRef<number | null>(null);
  const columnRef = React.useRef<HTMLDivElement | null>(null);
  const gripRef = React.useRef<HTMLDivElement | null>(null);

  const applyLiveTreeWidth = React.useCallback((nextWidth: number) => {
    const column = columnRef.current;
    if (!column) {
      return;
    }
    column.style.width = `${nextWidth}px`;
    column.style.setProperty('--oc-editor-tree-width', `${nextWidth}px`);
  }, []);

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!visible) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    liveWidthRef.current = width;
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!isResizing || pointerIDRef.current !== event.pointerId) {
      return;
    }
    const towardEditor = side === 'left' ? event.clientX - startXRef.current : startXRef.current - event.clientX;
    const delta = isRightToLeft(event.currentTarget) ? -towardEditor : towardEditor;
    const nextWidth = clampContextEditorTreeWidth(startWidthRef.current + delta);
    if (liveWidthRef.current === nextWidth) {
      return;
    }
    liveWidthRef.current = nextWidth;
    applyLiveTreeWidth(nextWidth);
  };

  const finishResize = React.useCallback((releasedPointerID: number | null) => {
    const pointerID = pointerIDRef.current;
    if (pointerID === null || (releasedPointerID !== null && releasedPointerID !== pointerID)) {
      return;
    }
    if (gripRef.current?.hasPointerCapture(pointerID)) {
      gripRef.current.releasePointerCapture(pointerID);
    }
    const finalWidth = clampContextEditorTreeWidth(liveWidthRef.current ?? width);
    pointerIDRef.current = null;
    liveWidthRef.current = null;
    setIsResizing(false);
    setWidth(finalWidth);
  }, [setWidth, width]);
  useWindowPointerRelease(isResizing, finishResize);

  const appliedWidth = visible ? width : 0;
  const stretched = fill && stretch && visible;

  return (
    <div
      ref={columnRef}
      className={cn(
        'relative h-full flex-shrink-0 overflow-hidden bg-background will-change-[width] motion-reduce:transition-none',
        fill && (side === 'left' ? 'me-auto' : 'ms-auto'),
      )}
      style={{
        width: stretched ? '100%' : `${isResizing ? (liveWidthRef.current ?? appliedWidth) : appliedWidth}px`,
        maxWidth: fill ? '100%' : undefined,
        ['--oc-editor-tree-width' as string]: `${isResizing ? (liveWidthRef.current ?? width) : width}px`,
        overflowX: 'clip',
        transitionProperty: isResizing || stretch ? 'none' : 'width',
        transitionDuration: '200ms',
        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      aria-hidden={!visible}
    >
      {visible && !fill && (
        <div aria-hidden="true" className={cn('pointer-events-none absolute inset-y-0 z-20 w-px bg-border', side === 'left' ? 'inset-e-0' : 'inset-s-0')} />
      )}
      {visible && !fill && (
        <div
          className={cn(
            'absolute top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            side === 'left' ? 'inset-e-0' : 'inset-s-0',
            isResizing && 'bg-[var(--interactive-border)]'
          )}
          ref={gripRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      <div
        className={cn(
          'relative z-10 h-full shrink-0 transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          isResizing && 'pointer-events-none',
          !visible && 'pointer-events-none select-none opacity-0'
        )}
        style={{ width: stretched ? '100%' : 'var(--oc-editor-tree-width)', maxWidth: fill ? '100%' : undefined }}
        aria-hidden={!visible}
      >
        {children}
      </div>
    </div>
  );
};
