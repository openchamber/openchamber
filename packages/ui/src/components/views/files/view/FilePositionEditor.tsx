import React from 'react';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { EditorView } from '@codemirror/view';

type FileEditorPosition = {
  scroll: ReturnType<EditorView['scrollSnapshot']>;
  anchor: number;
  head: number;
};

// Keep only position metadata, not editor instances or file contents. This
// survives FilesView unmounts without retaining every file visited indefinitely.
const fileEditorPositions = new Map<string, FileEditorPosition>();
const MAX_FILE_EDITOR_POSITIONS = 100;

export const FilePositionEditor = ({
  positionKey,
  onViewReady,
  ...props
}: React.ComponentProps<typeof CodeMirrorEditor> & { positionKey: string }) => {
  const viewRef = React.useRef<EditorView | null>(null);

  React.useLayoutEffect(() => () => {
    const view = viewRef.current;
    if (!view) return;

    // Read before React removes the editor DOM and its scroll offsets collapse.
    const { anchor, head } = view.state.selection.main;
    fileEditorPositions.delete(positionKey);
    fileEditorPositions.set(positionKey, { scroll: view.scrollSnapshot(), anchor, head });
    if (fileEditorPositions.size > MAX_FILE_EDITOR_POSITIONS) {
      const oldestKey = fileEditorPositions.keys().next().value;
      if (oldestKey !== undefined) fileEditorPositions.delete(oldestKey);
    }
  }, [positionKey]);

  return (
    <CodeMirrorEditor
      {...props}
      onViewReady={(view) => {
        viewRef.current = view;
        const position = fileEditorPositions.get(positionKey);
        if (position) {
          view.dispatch({
            selection: {
              anchor: Math.min(position.anchor, view.state.doc.length),
              head: Math.min(position.head, view.state.doc.length),
            },
            effects: position.scroll,
          });
        }
        onViewReady?.(view);
      }}
    />
  );
};
