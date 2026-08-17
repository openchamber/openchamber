/**
 * ghostty-web v0.4.0 implements copy-on-click: its SelectionManager's canvas
 * `mousedown` selects the clicked cell and its document-level `mouseup` copies
 * that single character to the clipboard. A plain left click into the terminal
 * (to focus it) therefore clobbers whatever the user copied before (e.g. from
 * the shell widget copy button). There is no option to disable it, so
 * TerminalViewport intercepts the document `mouseup` in the capture phase and
 * suppresses the copy for plain clicks. A real drag selection
 * (`hasSelection()` true) is left alone so ghostty still copies the selected
 * text; clicks outside the terminal container are filtered by the caller.
 */
export const shouldSuppressGhosttyCopyOnClick = (hasSelection: boolean): boolean => !hasSelection;
