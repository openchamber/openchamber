# Sidebar sections

The sidebar is an ordered list of sections. Four are built in (Chats, Pinned,
In work, Projects); the user adds their own, each a filter over the works the
sidebar lists or a group of whole projects. This folder owns which works each
section lists, the manager and editor that arrange and define them, and Pin to
with its named pin lists. How the rows are drawn stays with the row model
(`sessionSidebarRowModel.ts`, `SessionSidebarBlock`).

- `lib/sidebarSections.ts` (shared with the settings registry and the server
  sanitizer's copy): the stored shapes, `normalizeSidebarSections` (drops broken
  entries, restores missing built-in sections at their default place), the
  filter (`matchesSidebarSectionFilter`) and the editor's templates.
- `sectionMembership.ts`: `resolveVisibleSidebarSections` (what this surface
  draws, the section being edited included) and
  `resolveSidebarSectionMembership` (which works each section lists).
- `workFacts.ts`, `useSidebarLiveFacts.ts`: what a filter is matched against.
- `sectionActions.ts`: the editor's device-only state (`useSidebarSectionsUiStore`)
  and every write of sections, visibility and pin lists.
- `SidebarSectionsManager.tsx`: the manager and the editor, a popover beside the
  sidebar opened from the display menu. It loads on its first open. Its rows
  drag anywhere but their controls, as the sidebar's do (`../rowDrag.ts`); in
  the sidebar a section drags by its caption
  (`projects/SortableSidebarSection.tsx`), and both write the same order.
- `PinToMenu.tsx`, `NewPinListDialog.tsx`, `apps/mobileSidebar/MobilePinToSheet.tsx`:
  Pin to on the row menus, the swipe on the phone, and naming a new list.

## Invariants

- A section of the user's own lists every work that matches its filter, so one
  work can show in several. Its one choice is about projects: with "Also show
  under projects" off (`claims`), its works leave their projects; on, they stay
  there too and leave them only during a search. Pinned always takes its works
  out of their projects; In work does unless "Also show in work under projects"
  is on; between the two, the higher one lists a work that is both pinned and in
  work, as before. Projects lists what no section took out and no group of
  projects took, wherever it stands in the order.
- A group of projects (`grouping: 'project'`) takes whole projects, and only
  projects: its filter keeps `projectIds` alone, and it always takes them, so
  a project is drawn in one place (two project headers of one project would
  share row keys and sticky headers): from Projects, the list by time and any
  later group. It draws them under its own caption with the project headers the
  Projects caption has. The works of its projects still show in the user's
  other sections.
- A search lists each match once, in the first section that shows it: while a
  query is applied a work leaves its project, the later sections and the list
  by time.
- At most `SIDEBAR_SECTIONS_MAX` sections of the user's own and
  `SIDEBAR_PIN_LISTS_MAX` pin lists. The editor and Pin to stop offering a new
  one at the limit; the normalizer would otherwise drop one the user has.
- Activity filters ("Today", "Last 7 days", "Idle 3+ days") compare against a
  clock that moves by the local hour while such a section is shown
  (`useSidebarSectionsNow`), so "Today" turns over at local midnight in any
  time zone.
- "Scheduled run" is a type of its own beside what the work is (a session or a
  worktree): a work whose top-level session a scheduled task started
  (`openchamber.kind = 'scheduled'`, cleared on a fork). With the text
  condition it lists the runs of one task, whose sessions carry the task's name.
- The text condition ("Title or branch") matches as the sidebar search does
  (`SIDEBAR_SEARCH`): every word at the start of a word in the title of one
  of the work's top-level sessions, the worktree's name or its branch, so
  "fix" finds "fix/relay" and not "prefix" (maintainer, 2026-11-01: a standing
  section filling with mid-word matches is noise; the pickers keep matching
  anywhere). Save as section in the search makes a
  section from the query this way, then closes the search so the sidebar shows
  the section being made. Sections cached on the device by another build are
  read through the same rules as the stored setting (the persisted store's
  `merge`), so a field added later is never missing.
- Section definitions and pin lists are profile settings shared by every
  surface (`sidebarSections`, `sidebarPinLists`). Which sections a surface shows
  is its own: the user's sections through `sidebarHiddenSections` (per surface),
  the built-in ones through the show toggles they always had
  (`sidebarShowChatsSection`, `sidebarShowPinnedSection`, `sidebarShowWorkSection`),
  which older clients still read. Projects is always shown.
- Sections, pin lists and hidden sections belong to the instance they came
  from (`sectionsOwner` in the display store, stamped by every write). The local
  copy is a startup cache: switching to another instance, or starting on one,
  drops it back to the built-in sections until that instance's settings
  arrive, so one server's sections never show on another. A transient
  disconnected state keeps them.
- VS Code draws no section of the user's own; its list stays as it was.
- Live state (running, a waiting request, unread, failed) is subscribed only
  while a shown section filters on it, and only while the sidebar is visible.
  Unread and failed come from the session record (`time.idle` / `time.viewed`,
  `outcome`), so they survive a restart; running and waiting requests from the
  live indexes.
- The Plan link comes from project knowledge, which lives outside the session.
  It is read only for the projects a shown section asks plans of (every project
  when it names none), once each through the background gate, and again when
  the server sends `project-context-changed` for one of them; nothing polls.
- A pin's list lives where the pin does: `openchamber.pinned.list` in session
  metadata, `<at> <list>` in the branch's `openchamberPinned` for a worktree.
  Pinned lists the pins with no list. Deleting a list takes it out of every
  section's filter and deletes a section left asking for no pin list, whose
  other chips would otherwise list far more than it did; a pin filed in it stays
  pinned and shows in its project with the pin mark.

## Decisions

### Why sections are filters over works and not a second list of sessions

Pinned and In work were already filters with a fixed place: pinned works, works
in work. Making every section a filter over the same works keeps one row model,
one ordering and one set of rows; the user's sections and the built-in ones
differ only in their filter. A list of sessions per section would have needed
its own lineage, ordering and Track / Done rules.

### Why sections may repeat a work and the switch is about projects only

The first version handed works out from the top down: a section that took its
works hid them from its projects and from every section below it. That one
switch did two things, and the second depended on the order the user drags,
so "the sections below" read as noise (maintainer, 2026-10-31). Now a section
shows every work that matches, and its switch only says whether the work also
stays in its project.

### Why the user's sections leave works in their projects by default

A section that filters on live state would take a work out of its project at
the start of every turn and give it back at its end, so the list would jump
under the pointer. New sections keep "Also show under projects" on.

### Why the built-in sections keep their show toggles

Older clients read `sidebarShowPinnedSection` and its siblings. Keeping them as
the built-in sections' visibility means nothing has to be migrated and an older
build still shows what the user chose; only the order and the user's sections
are new.

### Why the editor shows only the conditions the section asks for

Every category's chips on screen at once read as a wall of identical buttons
(maintainer, 2026-10-31). The editor lists the conditions the section has, one
row each, and offers the rest behind "Add condition"; a row's menu picks its
values, its cross removes it.

### Why the text condition reads top-level titles and not subagent ones

The search also lists a work for a matching subsession, as context around the
match. A section is a standing list, and subagent titles ("apply
relay-transport", "Explore the codebase") would file whole works under a topic
one helper touched, so the condition reads the titles the rows show, the
worktree's name and its branch. A section saved from a search can therefore
list fewer works than the search showed.

### Why the manager panel is opaque and not glass

The editor opens menus over the panel. A glass panel under a glass menu left
the menu looking transparent, as the menu could not blur through it. The panel
takes the opaque floating surface with the same light and shadow; the menus
over it keep their glass.

### Why Pin to replaces the Pin item

The row menu has no room for another item. Pin becomes a submenu (Pinned, the
user's lists, a new list, Unpin), so manual collections need no mechanism of
their own: a list is a pin with a name, and a section shows it.
