import React from 'react';

import type { ContextPanelMode } from '@/stores/useUIStore';

/**
 * Whether a zone's content takes focus and input: false while the zone is
 * closed and, for most surfaces, through its opening animation, when the
 * zone frame keeps its card `inert` (ContextPanel). A surface that focuses
 * itself on being shown waits for it, since focusing inside an inert card
 * does nothing. True outside a zone.
 */
export const ZoneInteractiveContext = React.createContext(true);

export const useZoneInteractive = (): boolean => React.useContext(ZoneInteractiveContext);

/**
 * How many file surfaces show a CodeMirror editor now. A file shown rendered
 * (Markdown, a page, an image) or a zone showing only the tree has none.
 */
let detachableEditors = 0;

/** Rendered beside a file surface's CodeMirror editor, for as long as it is the view. */
export const DetachableEditorMarker: React.FC = () => {
  React.useLayoutEffect(() => {
    detachableEditors += 1;
    return () => {
      detachableEditors -= 1;
    };
  }, []);
  return null;
};

/**
 * Whether an opening zone showing `mode` leaves `inert` at once rather than
 * when its animation ends. Taking a surface out of `inert` restyles it and,
 * with an accessibility client on, adds it to the tree: deferred, that work
 * leaves the animation's first frame (a 150-file diff's took 110 ms instead
 * of 70). The file editor is the exception. Its CodeMirror DOM goes back into
 * the document as the zone opens (CodeMirrorEditor `detached`), and coming
 * out of `inert` in that same commit is cheap; deferred, the editor already
 * in place came out of `inert` with a 300 ms frame at the end of the
 * animation. Only while an editor is what the file surface shows: a rendered
 * file re-attaches nothing, and leaving `inert` at once restyled all of it in
 * the frame of the click (25 ms for a long Markdown file), so every open
 * started a frame or two late.
 */
const leavesInertOnOpen = (mode: ContextPanelMode | undefined): boolean => mode === 'file' && detachableEditors > 0;

/**
 * Whether the zone's content is out of `inert`, from its open state, its
 * state as of the end of its animation (`useOpenWhenSettled`) and the
 * surface it shows. A closing zone always stays exposed until the end.
 */
export const isZoneExposed = (isOpen: boolean, settledOpen: boolean, mode: ContextPanelMode | undefined): boolean => (
  settledOpen || (isOpen && leavesInertOnOpen(mode))
);
