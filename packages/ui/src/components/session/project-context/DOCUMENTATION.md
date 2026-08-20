# Project Context Panel

Notes, todos, saved plans, and agent memory for the active project. Rendered by
the `notes` surface in the desktop context rail and by the mobile workspace
drawer.

## Files

| File | Owns |
|---|---|
| `ProjectNotesTodoPanel.tsx` | container: store subscription, load, failure toast, section sidebar, search query, the todo write |
| `NotesSection.tsx` | note composer, note list, per-note edit/pin/delete |
| `TodosSection.tsx` | todo list, add/toggle/delete/clear, drag reorder, list resize |
| `PlansSection.tsx` | plan list, import, pin, delete, open |
| `MemorySection.tsx` | agent memory list, project/global scope switch, new/changed badges, edit, forget |
| `KnowledgeCard.tsx` | the shared card shell and expand interaction every entry list uses |
| `useProjectTodoSend.ts` | sending a todo to a current/new/worktree session |

## Layout

Content on the left, a section sidebar on the right with a drag-to-resize edge —
the same arrangement the files surface uses, so the two panels do not disagree
about where navigation lives. The sections were a horizontal tab strip until four of them stopped
fitting: a strip has one line of width to divide, and each section added took
width from the rest, while a vertical list grows downwards where there is room.
The surface's default width matches the files surface for the same reason; at a
third of the window the content column is too narrow to read a note in.

Search shares the title row rather than owning one of its own: it filters what
is already on screen, and a full-width field read as the panel's primary control.
It stays above both columns. Sections divide, and search is the one thing
that division would hurt — you do not always remember whether something was
written as a note or lives in a plan — so each sidebar entry carries its own
match count.

## One card, one interaction

Every entry list renders `KnowledgeCard`. Notes and memories had drifted into
two different-looking rows in the same panel — one a bare block of text opened by
clicking the text, the other a bordered card opened by a chevron — which is the
kind of split that makes a panel feel unfinished regardless of how either half
behaves.

A collapsed card opens on a click anywhere on it. An expanded card closes only
through its collapse action, because its body is editable and a stray click in
the text must not throw the editor away.

## Plans open in place

Clicking a plan replaces the list with its editor, and the back control appears
in the panel header beside the project name — PlanView titles the plan itself, so
a title row above it would say the same thing twice. A plan belongs to the project this
panel is about, and sending the reader to another tab to read it made them leave
the surface they were browsing.

The editor is `PlanView`, lazily imported — it is a large view and most panel
visits never open one. It scrolls itself, so the content column stops scrolling
while a plan is open; two scrollbars for one document is what nesting them gives.
Leaving the section or the project closes it, so its editor never sits over a
list it no longer matches. Hosts that own a fullscreen plan surface (mobile)
still pass `onOpenPlan` and keep theirs.

## Pins belong to one session

Notes and plans are project data, but attaching one writes its id to the current
session metadata. Other sessions in the project do not inherit it. A pin made
while a new-session draft is open lives on that draft and transfers only to the
session created by its first message. Work status lists and detaches draft pins
before that first message, then reads them from the created session metadata.

## Memory is not a fifth kind of note

The first four tabs hold what the user wrote. Memory holds what the **agent**
wrote for itself, in its own store (`packages/web/server/lib/agent-memory`) and
through its own client (`useAgentMemoryStore`). They share the panel and nothing
else — keeping the stores apart is what stops an agent mistake from landing in
the user's notes.

Two consequences shape this tab:

- **Entries are editable.** A memory worded badly enough to mislead should be
  fixable where it is read; deleting it and hoping the agent learns it again,
  better, is not a repair. The agent rewrites by saving the same memory again,
  so `PATCH` exists for the panel alone.
- **Nothing gates the agent, and nothing asks the user to click.** An earlier
  version had a confirm button. It was theatre: the agent already had the
  memory whether or not the button was pressed, so the click bought the user
  nothing. Entries now carry `new` and `changed` badges derived from
  `createdAt` / `updatedAt` against a per-scope "last looked" mark, and looking
  at the tab is the acknowledgement. Nothing about review is stored server-side.
- **The scopes are a switch, never one merged list.** A claim about the user
  reaches every project, so which store an entry sits in is the most important
  thing about it and must not be something the reader has to infer. The switch
  is a chip group, not a tab strip: it picks which store you are reading, not
  which view you are in, and the pressed state reads plainly against the
  panel background.

The mark is frozen while the tab is open and advanced on the way out, or every
badge would clear the instant the tab appeared — the one moment the user is
trying to read them. Each project keeps its own mark, so opening one project
cannot silently clear another's badges.

The store is loaded by `useAgentMemorySync` in `App.tsx` and reloads on
`openchamber:agent-memory-changed`, because the agent writes mid-turn through
its own tool. It feeds this panel only — what a session is told about memory is
decided server-side by `packages/web/server/lib/session-knowledge`, so it
reaches sessions that have no UI at all and survives compaction.

Both sides resolve a worktree to its project before touching the store — the
client through `resolveProjectForSessionDirectory`, the server through
`agent-memory/project-resolution`. Keying by the session directory instead filed
a worktree's memories under a project nothing reads.

Turning the switch back on re-reads the store only after the setting has
finished being written. The switch flips the client immediately, which makes the
panel ask the server straight away — and mid-write the server truthfully answers
"disabled", which used to latch the tab hidden until a restart. Loads are also
sequenced, so that stale answer cannot land after the good one.

`agentMemoryToolEnabled` is one switch for the whole feature: it removes the
tool from the agent, this tab from the panel, and the index from new sessions.
The tab also hides when the server reports the surface disabled, so a stale
client cannot keep showing memory that is off. A persisted `memory` tab
selection falls back to `notes` rather than opening a tab that no longer exists.

## Data flow

Storage is server-owned; see
`packages/web/server/lib/project-context/DOCUMENTATION.md`. The panel never
touches `/api/fs/*` and never handles a plan path — plans are addressed by id.

```
useProjectContextStore  ->  ProjectNotesTodoPanel  ->  sections
      (server cache)          (load + shared write)
```

There is deliberately no cross-panel event. An earlier version broadcast
`openchamber:project-notes-updated` / `openchamber:project-plan-saved` on the
window and every mounted panel re-read the whole config in response. Writers now
mutate the store and readers re-render from it.

## Where writes live

Notes, todos, and plans each have their own routes, so each section owns its
writes end to end and no section has to persist a neighbour's state alongside
its own. `NotesSection` and `PlansSection` call the store directly. Todos still
route through the container only because the container already holds the list it
sorts for display.

An earlier version wrote notes and todos together in one request. That forced
the container to own the notes draft, because otherwise a todo toggle would
persist whatever notes were last committed and discard unsaved typing. Splitting
the routes removed the coupling rather than managing it.

## Layout

The three lists are tabs, not one stacked column. Stacking gave each list its
own scroller inside the panel's scroller, and it only got worse as lists grew —
the todo list had to carry a manual resize handle just to stay usable. With
tabs there is exactly one scroller: the panel's. The resize handle and its
persisted `todoPanelHeight` are gone with it, and each section renders its list
at natural height.

The host (`RightSidebarTabs`) therefore sets `overflow-hidden`; putting a
scroller there again would nest one inside the other.

Section headers no longer repeat their own name or count — the tab carries both.

The active tab persists in `useUIStore` so switching surfaces or remounting the
panel returns to where the user was.

## Search

One query in the container filters all three tabs, and the tab bar doubles as
the result summary: each tab shows its match count. Tabs divide, and search is
the one thing division would hurt — you do not always remember whether
something was written as a note or lives in a plan — so search deliberately
stays above the tabs rather than becoming per-tab.

If the active tab has no matches and another does, the panel follows the search
there. Without that, typing a query whose hits live elsewhere shows an empty
list and the user has to guess which tab to try.

Filtering is display-only: every mutation still acts on the full list, so
reordering or clearing completed todos while a filter is active cannot drop
hidden items. The query resets when the project changes, since a query that
matched the old project would silently hide everything in the new one.

## Invariants

- **Each note row keeps a local, debounced draft.** Writing on every keystroke
  would put a request behind every character, and re-reading the store each
  render would fight the caret.
- **An external note change is adopted only while that row is untouched** since
  its last save. "Add to notes" from a chat selection must reach an open panel,
  but must never overwrite what the user is typing.
- **Only one note is expanded at a time, and collapsed notes are clamped.**
  Notes run to 3000 characters each; with the panel owning the only scroller,
  unbounded rows turn the tab into one unbroken wall of text. A collapsed note
  shows a three-line preview and expands into its editor on click.
- **A blanked note body is never persisted.** The server rejects it, so the row
  restores its last saved text on blur rather than showing a phantom failure.
  Deleting is an explicit action.
- **A load failure never blanks the panel.** The store keeps the last good
  snapshot; the panel toasts once, and only when nothing had loaded yet.
- **Completed todos sink to the bottom for display only.** Stored order is what
  the user dragged.
- **Plan creation is not optimistic.** The id and file name come from the
  server, and a row that cannot be opened is worse than a brief wait.

## Pinned context

The pin toggle on a note or plan attaches it to the current session or draft.
Assembly and delivery live in `packages/web/server/lib/session-knowledge`.

## Related

- Store: `packages/ui/src/stores/useProjectContextStore.ts`
- HTTP client: `packages/ui/src/lib/projectContextApi.ts`
- Plan viewer/editor: `packages/ui/src/components/views/PlanView.tsx`
- User docs: `packages/docs/content/docs/notes-todos-plans.mdx`
