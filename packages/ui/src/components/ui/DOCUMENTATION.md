# Shared UI primitives

## Ownership

This folder owns runtime-independent controls and their Base UI integration, including dropdown focus and dismissal. Feature-specific model filtering belongs to `components/model-picker`.

## Invariants

- A root dropdown opened by keyboard or controlled state stays open when the pointer leaves its popup. Hover dismissal applies only to a dropdown opened by trigger hover.
- Escape, outside presses, item selection, and window blur retain their normal dismissal behavior. Submenu hover behavior stays with Base UI.
- An open dropdown whose content changes (a filtered picker list, items that arrive late) eases into its new height (`useHeightMorph` in `DropdownMenuContent`); the edge facing the trigger stays where it was in every painted frame.
- Each opening has its own hover-dismissal eligibility; closing clears it.
- Command palette recent sessions and session-name search share the session
  admission filter. Their raw global cache remains complete; registering a
  destination updates the open palette through its project/worktree subscriptions.
- Icon actions over a document (the Files editor, a plan, a page, image or diagram in the chat, diff headers) use `ToolbarButton` from `action-toolbar.tsx`: 24px, a 14px icon, colour-only hover, the selection fill while a toggle is on, faded while disabled. A toggle keeps one icon and one label naming the option; the fill says whether it is on.
- `ActionToolbar` takes the actions a document has, which depend on what the document is and never on its mode, so a mode switch moves no button. Its groups sit apart by space; with `fold`, unpinned actions move into "More actions" from the end of the row while it does not fit, after `start` gave up its width.
- `Textarea` offers emoji on `:` in both modes (`components/emoji/`, placed by `components/inline-picker/`); its forwarded ref is the textarea element itself.
- Every scroller a user sees draws the app's overlay scrollbar, never the native one: `ScrollableOverlay` for a scroller the caller renders, `AttachedOverlayScrollbar` for one a library creates (CodeMirror's `.cm-scroller`), `PopupOverlayScrollbar` for a popup that scrolls itself (`DialogContent`, `DropdownMenuContent`, `ContextMenuContent`, the framed `Textarea`). A new `overflow-auto` element goes through one of them. Only fallback screens after a crash keep the native bar, so they depend on nothing that may have failed.
- `OverlayScrollbar` draws a thumb only on an axis whose computed overflow is `auto` or `scroll`: a scroller its owner switched to `hidden`, or a menu left at `visible`, overflows without scrolling and shows none.

## Decisions

### Why the toolbar folds by trying, not by arithmetic

`ActionToolbar` hides actions from the end of the row through a `data-folded` attribute set on the DOM until the row stops overflowing, then renders the menu from what it hid. Counting fixed 24px slots, as the Files toolbar did before, breaks on anything that is not a button: the save status, the inline go-to-line field, labels in other languages. React never renders `data-folded`, so a render keeps the fit until the next one runs on a resize or a changed set of actions.

### Why hover dismissal follows the opening reason

Base UI 1.4 has no opening DOM event when a caller changes the controlled `open` prop, so it treats that popup as hover-dismissible. Filtering can shrink it away from a stationary pointer and close it during typing. The shared dropdown root cancels that hover close unless a trigger-hover event opened the menu, preserving explicit hover menus without caller-specific workarounds.

### Why a scrolling popup gets a sibling frame and not a wrapper

A dialog window and a menu are their own scroll containers: Base UI renders the popup, and callers size, pad and lay it out through its `className`. A thumb placed inside it would scroll away with the content, and wrapping the content in `ScrollableOverlay` would move every caller's padding, gap and overflow classes onto a new element. `PopupOverlayScrollbar` instead renders next to the popup in the same positioned parent and keeps a frame on the popup's `offsetTop/Left/Width/Height`. Offsets ignore the open and close scale, so the frame lands where the popup comes to rest; client rects read during the opening animation were 2% small.

### Why the height morph watches content and leaves the position to Base UI

The popup's height follows a `MutationObserver` on its content, not a `ResizeObserver` on the box: the animation itself resizes the box every frame, and a flex child such as the model list shrinks with it, so a size observer would restart the move on every frame. The hook also does not hold the anchored edge itself. Base UI's positioner re-places the popup from its animated height before paint in the same frame, so the edge facing the trigger stays put; a per-frame offset tried first doubled that correction and threw the edge up to 60px off.
