import type React from 'react';
import { isEditorEventTarget } from '@/lib/editorFocus';
import { isTerminalEventTarget } from '@/lib/terminalFocus';

/**
 * Escape closes a zone. Called from a capture handler on the zone frame and
 * on each keep-alive pane (their React events do not pass through the frame:
 * they are portalled in from `ContextSurfacePanes`).
 */
export const closeZoneOnEscape = (
  event: React.KeyboardEvent<HTMLElement>,
  isOpen: boolean,
  close: () => void,
  // What counts as inside the zone. A pane passes its zone frame: the pane's
  // toolbar is portalled into the frame's header, outside the pane itself.
  scope: Element | null = event.currentTarget,
): void => {
  // Closed, a zone holds nothing whose Escape is its to take (the right one
  // holds only the work-status card).
  if (event.key !== 'Escape' || !isOpen) {
    return;
  }

  // Portalled menus and dialogs own Escape even though their React events
  // still pass through this capture handler.
  if (event.target instanceof Node && !(scope ?? event.currentTarget).contains(event.target)) {
    return;
  }

  // Terminal owns Escape so the PTY receives it (e.g. Vim Normal mode).
  // The terminal input listens in the bubble phase; stopping capture here
  // would swallow the key before the terminal ever sees it (issue #2644).
  if (isTerminalEventTarget(event.target)) {
    return;
  }
  // Same for the file editor and what it opens over itself (search, the
  // symbol list, go to line): Escape closes those, leaves Vim's INSERT mode
  // or collapses several cursors, and must not close the whole zone.
  if (isEditorEventTarget(event.target)) {
    return;
  }
  // Something under the zone already handled this Escape.
  if (event.defaultPrevented) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  close();
};
