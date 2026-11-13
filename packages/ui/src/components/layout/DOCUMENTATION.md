# Layout

This file covers the header's session tabs. The tab store, its scopes and
seeding are owned by `stores/DOCUMENTATION.md` (`useSessionTabsStore`).

## Header session tabs

`SessionTabsStrip.tsx` is the header's horizontal working set of sessions, in
the web and desktop header while `sessionTabsEnabled` is on. VS Code and the
setting turned off keep the plain session title (`Header.tsx`). The VS Code
chat header (`VSCodeHeader` in `VSCodeLayout.tsx`) keeps the title as the
session switcher and puts a "⋯" menu beside it with Rename only; the other
session actions stay in the session list.

- The store keeps ids and order only. An id whose session is not in the
  loaded list stays stored and does not render, so a partial session list
  never destroys the working set.
- Every tab has the same fixed width (`w-44`); tabs that shrink as more open
  were considered and rejected by the maintainer. Overflow scrolls, with an
  edge fade while tabs hide behind it.
- A long title fades out at its end (`.session-tab-title` in `index.css`)
  rather than ending in an ellipsis, which read as clutter next to the state
  mark.
- The running or unread mark sits at the tab's end and takes room only while
  shown. The project icon sits at the start; on hover or keyboard focus the
  close button takes its slot, so the tab reserves no room for a control.
- The session menu opens on right-click only, without changing the active
  tab. It is the sidebar row's session menu (`SessionActionsMenuItems` in
  `components/session/sidebar/sessions/`, through
  `HeaderSessionActionsMenuItems.tsx`), with Close other tabs first, and acts
  on the clicked tab's session whether it is active or not. The title's "⋯"
  menu, with tabs off, is the same menu for the current session. A per-tab
  "⋯" button and controls visible at rest were removed and stay out. A new tab affordance follows the sidebar row patterns
  (`components/session/sidebar/DOCUMENTATION.md`): revealed on hover, menu on
  right-click.
- A "+" right after the last tab, outside the scroller so it stays in view,
  opens a new draft in the folder the tabs belong to. While tabs are shown the
  titlebar's New session button is hidden (`TitlebarLeftControls.tsx`), since
  it would be a second button starting the session in the project root; a
  full-page surface hides the tabs and brings it back.
- An open new-session draft is a tab at the end, titled with the first line of
  its saved text, else "New session". Leaving the draft removes the tab; the
  draft stays in the sidebar.
- In the desktop app Cmd/Ctrl+W closes the open session tab and activates its
  neighbour, and with nothing to close it closes the window. Web keeps the
  configurable `close_session_tab` shortcut (Alt+W by default), since the
  browser owns Cmd/Ctrl+W.
