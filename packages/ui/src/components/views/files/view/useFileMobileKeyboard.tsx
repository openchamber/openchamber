import React from 'react';
import { EditorView } from '@codemirror/view';
import { type useFileEditor } from './useFileEditorExtensions';

export function useFileMobileKeyboard({ editor, isMobile }: {
  editor: Pick<ReturnType<typeof useFileEditor>, 'editorViewRef'>;
  isMobile: boolean;
}) {
  const { editorViewRef } = editor;
  const nudgeEditorSelectionAboveKeyboard = React.useCallback((view: EditorView | null) => {
    if (!isMobile || !view || typeof window === 'undefined') {
      return;
    }

    const activeElement = document.activeElement;
    const commentInput = !view.hasFocus && activeElement instanceof HTMLElement && view.dom.contains(activeElement)
      ? activeElement.closest<HTMLElement>('[data-comment-input="true"]')
      : null;
    if (!view.hasFocus && !commentInput) {
      return;
    }

    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }

    const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
    const occludedBottom = Math.max(0, layoutHeight - (viewport.offsetTop + viewport.height));
    if (occludedBottom <= 0) {
      return;
    }

    const cursorRect = commentInput
      ? commentInput.getBoundingClientRect()
      : view.coordsAtPos(view.state.selection.main.head);
    if (!cursorRect) {
      return;
    }

    const visibleBottom = Math.round(viewport.offsetTop + viewport.height);
    const clearance = 20;
    const overlap = cursorRect.bottom + clearance - visibleBottom;
    if (overlap <= 0) {
      return;
    }

    view.scrollDOM.scrollTop += overlap;
  }, [isMobile]);

  React.useEffect(() => {
    if (!isMobile || typeof window === 'undefined') {
      return;
    }

    const runNudge = () => {
      window.requestAnimationFrame(() => {
        nudgeEditorSelectionAboveKeyboard(editorViewRef.current);
      });
    };

    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', runNudge);
    viewport?.addEventListener('scroll', runNudge, { passive: true });
    document.addEventListener('selectionchange', runNudge);

    return () => {
      viewport?.removeEventListener('resize', runNudge);
      viewport?.removeEventListener('scroll', runNudge);
      document.removeEventListener('selectionchange', runNudge);
    };
  }, [isMobile, nudgeEditorSelectionAboveKeyboard]);

  return { nudgeEditorSelectionAboveKeyboard };
}
