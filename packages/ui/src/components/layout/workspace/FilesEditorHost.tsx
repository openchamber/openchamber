import React from 'react';
import { createPortal } from 'react-dom';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import {
  createFilesEditorWorkspace,
  FilesEditorContext,
  useFilesEditorWorkspace,
  type FilesEditorPlacement,
} from './filesEditorWorkspace';

/** Scopes the one Files editor to this workspace. */
export const FilesEditorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [workspace] = React.useState(createFilesEditorWorkspace);
  return <FilesEditorContext.Provider value={workspace}>{children}</FilesEditorContext.Provider>;
};

/**
 * Marks where the Files editor goes inside a zone. The editor itself is not
 * rendered here: each zone has its own panel, so rendering it in the zone
 * would remount it, and lose unsaved edits, whenever Files moves to another
 * zone. `FilesEditorHost` renders it once and moves it into this slot.
 */
export const FilesEditorSlot: React.FC<Omit<FilesEditorPlacement, 'element'>> = ({ visible, onKeyDownCapture }) => {
  const workspace = useFilesEditorWorkspace();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    workspace.setPlacement({ element, visible, onKeyDownCapture });
    return () => {
      if (workspace.getPlacement()?.element === element) workspace.setPlacement(null);
    };
  }, [onKeyDownCapture, visible, workspace]);
  return <div ref={ref} className="h-full w-full" />;
};

/**
 * The one Files editor of the workspace. It stays mounted while Files has an
 * open file, wherever Files is docked and while it is hidden, and its DOM
 * node is moved into the current zone's slot, so a move keeps the same editor
 * with its unsaved edits, undo history and cursor. Between one slot leaving
 * and the next arriving, the node is simply detached; the host removes it
 * when it unmounts.
 *
 * React events from the editor bubble through this component, not through the
 * zone's panel, so the zone's own key handling (Escape collapses the zone) is
 * attached here, taken from the slot.
 */
export const FilesEditorHost: React.FC<{
  mounted: boolean;
  /** The editor, told whether its zone shows it. */
  renderEditor: (visible: boolean) => React.ReactNode;
}> = ({ mounted, renderEditor }) => {
  const workspace = useFilesEditorWorkspace();
  const current = React.useSyncExternalStore(workspace.subscribe, workspace.getPlacement, workspace.getPlacement);
  const [node] = React.useState(() => document.createElement('div'));
  React.useLayoutEffect(() => {
    node.className = 'h-full w-full';
    if (current && node.parentElement !== current.element) current.element.appendChild(node);
  }, [current, node]);
  React.useLayoutEffect(() => () => node.remove(), [node]);

  if (!mounted) return null;
  return createPortal(
    <div className="h-full w-full" onKeyDownCapture={current?.onKeyDownCapture}>
      <ErrorBoundary>
        <React.Suspense fallback={null}>
          {renderEditor(current?.visible ?? false)}
        </React.Suspense>
      </ErrorBoundary>
    </div>,
    node,
  );
};
