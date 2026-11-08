import React from 'react';
import type { EditorView, lineNumbers } from '@codemirror/view';

type LineRange = {
  start: number;
  end: number;
};

type LineNumbersConfig = NonNullable<Parameters<typeof lineNumbers>[0]>;

// A drag closer than this to the editor's top or bottom edge, or past it,
// scrolls the editor; the step grows with the distance, up to the cap. Inside
// the editor it scrolls only once the range has grown, so a click that wobbles
// on the first or last visible line stays a click.
const AUTO_SCROLL_EDGE_PX = 8;
const AUTO_SCROLL_MAX_STEP_PX = 24;

interface UseLineNumberDragSelectionOptions {
  lineSelection: LineRange | null;
  setLineSelection: (range: LineRange | null) => void;
  // Called after a click on the only selected line clears the selection.
  onClear: () => void;
  isMobile: boolean;
}

interface LineNumberDragSelection {
  isDragging: boolean;
  lineNumbersConfig: LineNumbersConfig;
  // True while the click that ends a drag is being dispatched.
  isDragReleaseClick: () => boolean;
}

const lineAtClientY = (view: EditorView, clientY: number): number => {
  const rect = view.scrollDOM.getBoundingClientRect();
  const y = Math.min(Math.max(clientY, rect.top), rect.bottom - 1);
  const block = view.lineBlockAtHeight(y - view.documentTop);
  return view.state.doc.lineAt(block.from).number;
};

const autoScrollStep = (view: EditorView, clientY: number, rangeGrew: boolean): number => {
  const rect = view.scrollDOM.getBoundingClientRect();
  if (!rangeGrew && clientY >= rect.top && clientY < rect.bottom) {
    return 0;
  }
  if (clientY < rect.top + AUTO_SCROLL_EDGE_PX) {
    return -Math.min(AUTO_SCROLL_MAX_STEP_PX, rect.top + AUTO_SCROLL_EDGE_PX - clientY);
  }
  if (clientY > rect.bottom - AUTO_SCROLL_EDGE_PX) {
    return Math.min(AUTO_SCROLL_MAX_STEP_PX, clientY - (rect.bottom - AUTO_SCROLL_EDGE_PX));
  }
  return 0;
};

/**
 * Selecting lines for a comment by pressing on a line number and dragging.
 *
 * The press comes from the line-number gutter; the drag is followed on the
 * window, so the range keeps following the pointer's height after it drifts
 * into the code or out of the editor, and the editor scrolls while the pointer
 * is held at its top or bottom edge. The returned config keeps its identity, so
 * the gutter is never rebuilt by a render.
 */
export function useLineNumberDragSelection({
  lineSelection,
  setLineSelection,
  onClear,
  isMobile,
}: UseLineNumberDragSelectionOptions): LineNumberDragSelection {
  const [isDragging, setIsDragging] = React.useState(false);
  const latestRef = React.useRef({ lineSelection, setLineSelection, onClear, isMobile });
  latestRef.current = { lineSelection, setLineSelection, onClear, isMobile };
  const stopDragRef = React.useRef<(() => void) | null>(null);
  const releaseClickRef = React.useRef(false);

  React.useEffect(() => () => stopDragRef.current?.(), []);

  const startDrag = React.useCallback((view: EditorView, anchor: number) => {
    stopDragRef.current?.();
    let lastLine = anchor;
    let rangeGrew = false;
    let pointerY = 0;
    let frame = 0;

    const extendTo = (line: number) => {
      if (line === lastLine) return;
      lastLine = line;
      rangeGrew = true;
      latestRef.current.setLineSelection({ start: Math.min(anchor, line), end: Math.max(anchor, line) });
    };
    const scrollFrame = () => {
      frame = 0;
      const step = autoScrollStep(view, pointerY, rangeGrew);
      if (step === 0) return;
      const before = view.scrollDOM.scrollTop;
      view.scrollDOM.scrollTop = before + step;
      if (view.scrollDOM.scrollTop === before) return;
      extendTo(lineAtClientY(view, pointerY));
      frame = requestAnimationFrame(scrollFrame);
    };
    const stop = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      if (frame) cancelAnimationFrame(frame);
      stopDragRef.current = null;
      setIsDragging(false);
    };
    function handleMove(event: MouseEvent) {
      // Released where no mouseup reached the page.
      if ((event.buttons & 1) === 0) {
        stop();
        return;
      }
      pointerY = event.clientY;
      extendTo(lineAtClientY(view, pointerY));
      if (!frame) frame = requestAnimationFrame(scrollFrame);
    }
    function handleUp() {
      stop();
      // The click after a drag lands on what the pointer ended over, rarely the
      // pressed line number; the views must not take it for a click outside.
      // It is dispatched in the same task as this mouseup.
      releaseClickRef.current = true;
      window.setTimeout(() => {
        releaseClickRef.current = false;
      }, 0);
    }

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    stopDragRef.current = stop;
    setIsDragging(true);
  }, []);

  const lineNumbersConfig = React.useMemo<LineNumbersConfig>(() => ({
    domEventHandlers: {
      mousedown: (view, line, event) => {
        if (!(event instanceof MouseEvent) || event.button !== 0) {
          return false;
        }
        event.preventDefault();

        const { lineSelection: selection, setLineSelection: select, onClear: clear, isMobile: mobile } = latestRef.current;
        const lineNumber = view.state.doc.lineAt(line.from).number;

        if (
          selection &&
          !event.shiftKey &&
          Math.min(selection.start, selection.end) === lineNumber &&
          Math.max(selection.start, selection.end) === lineNumber
        ) {
          select(null);
          clear();
          return true;
        }

        // Mobile: tap-to-extend selection
        if (mobile && selection && !event.shiftKey) {
          select({
            start: Math.min(selection.start, selection.end, lineNumber),
            end: Math.max(selection.start, selection.end, lineNumber),
          });
          return true;
        }

        if (selection && event.shiftKey) {
          select({ start: Math.min(selection.start, lineNumber), end: Math.max(selection.end, lineNumber) });
        } else {
          select({ start: lineNumber, end: lineNumber });
        }
        startDrag(view, lineNumber);
        return true;
      },
    },
  }), [startDrag]);

  const isDragReleaseClick = React.useCallback(() => releaseClickRef.current, []);

  return { isDragging, lineNumbersConfig, isDragReleaseClick };
}
