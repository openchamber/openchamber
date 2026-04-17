import React from 'react';

import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type GoToLineDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: EditorView | null;
};

type CursorSnapshot = {
  character: number;
  lineNumber: number;
  selection: EditorSelection;
};

const resolveLineNumber = (rawValue: string, view: EditorView | null): number | null => {
  if (!view) {
    return null;
  }

  const parsed = Number.parseInt(rawValue.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }

  return Math.min(parsed, view.state.doc.lines);
};

const getCursorSnapshot = (view: EditorView, selection: EditorSelection): CursorSnapshot => {
  const line = view.state.doc.lineAt(selection.main.head);
  return {
    lineNumber: line.number,
    character: selection.main.head - line.from + 1,
    selection,
  };
};

const moveSelectionToLine = (view: EditorView, lineNumber: number, preferredCharacter: number) => {
  const line = view.state.doc.line(lineNumber);
  const nextCharacter = Math.max(1, Math.min(preferredCharacter, line.length + 1));
  const position = line.from + nextCharacter - 1;

  view.dispatch({
    selection: EditorSelection.cursor(position),
    effects: EditorView.scrollIntoView(position, { y: 'center' }),
  });
};

export function GoToLineDialog({ open, onOpenChange, view }: GoToLineDialogProps) {
  const [inputValue, setInputValue] = React.useState('');
  const initialCursorRef = React.useRef<CursorSnapshot | null>(null);
  const committedRef = React.useRef(false);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const lineNumber = React.useMemo(
    () => resolveLineNumber(inputValue, view),
    [inputValue, view],
  );

  React.useEffect(() => {
    if (!open || !view) {
      return;
    }

    committedRef.current = false;
    initialCursorRef.current = getCursorSnapshot(view, view.state.selection);
    setInputValue('');
  }, [open, view]);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [open]);

  React.useEffect(() => {
    if (!open || !view || !initialCursorRef.current) {
      return;
    }

    if (lineNumber === null) {
      const { selection } = initialCursorRef.current;
      view.dispatch({
        selection,
        effects: EditorView.scrollIntoView(selection.main.from, { y: 'center' }),
      });
      return;
    }

    moveSelectionToLine(view, lineNumber, initialCursorRef.current.character);
  }, [lineNumber, open, view]);

  const restoreInitialSelection = React.useCallback(() => {
    if (!view || committedRef.current || !initialCursorRef.current) {
      return;
    }

    const { selection } = initialCursorRef.current;
    view.dispatch({
      selection,
      effects: EditorView.scrollIntoView(selection.main.from, { y: 'center' }),
    });
  }, [view]);

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      restoreInitialSelection();
    }
    onOpenChange(nextOpen);
  }, [onOpenChange, restoreInitialSelection]);

  const handleSubmit = React.useCallback(() => {
    if (!view || lineNumber === null || !initialCursorRef.current) {
      return;
    }

    committedRef.current = true;
    moveSelectionToLine(view, lineNumber, initialCursorRef.current.character);
    onOpenChange(false);
    view.focus();
  }, [lineNumber, onOpenChange, view]);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      const target = event.target;
      if (!panel || !(target instanceof Node) || panel.contains(target)) {
        return;
      }
      handleOpenChange(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      handleOpenChange(false);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [handleOpenChange, open]);

  const helperText = React.useMemo(() => {
    if (!view) {
      return 'Editor unavailable.';
    }

    if (lineNumber === null) {
      const snapshot = initialCursorRef.current ?? getCursorSnapshot(view, view.state.selection);
      return `Current Line: ${snapshot.lineNumber}. Type a line number between 1 and ${view.state.doc.lines} to navigate to.`;
    }

    return `Go to line ${lineNumber}`;
  }, [lineNumber, view]);

  return (
    <div
      ref={panelRef}
      className={cn(
        'absolute left-3 top-3 z-40 w-[min(32rem,calc(100%-1.5rem))] rounded-xl border border-[var(--interactive-border)] bg-[color:color-mix(in_srgb,var(--surface-elevated)_94%,transparent)] p-2.5 shadow-lg backdrop-blur-sm transition-all',
        open ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none -translate-y-1 opacity-0',
      )}
    >
      <div className="min-w-0">
        <Input
          ref={inputRef}
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              handleSubmit();
            }
          }}
          placeholder="Line number"
          className="h-8 w-full rounded-md border-border/70 bg-background/60 typography-ui-label"
        />
        <div className="mt-2 rounded-md bg-primary/15 px-3 py-1.5 typography-ui-label text-foreground/95">
          {helperText}
        </div>
      </div>
    </div>
  );
}
