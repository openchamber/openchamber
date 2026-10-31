# Issues panel with host-provided label and milestone filters

Date: 2026-10-31
Status: proposed, awaiting review

## Problem

Grooming a milestone means working through its issues one by one and asking
questions about them. Today the only issue list inside OpenChamber is the
Issues and PRs board, a full page over the chat area. The list and the chat
are never on screen at once, and the board's filters are a state menu, a
people menu and a free-text search box. People do not remember their repo's
label and milestone names, so a search box is a poor filter for narrowing to
one milestone while grooming.

## What happens now

- The board (since v2.5.0) lists a project's issues and PRs on the host that
  owns the project's read context, with state and people filters and a search
  box. It replaces the chat area; it stays mounted and reopens where it was
  left.
- The knowledge panel (Project knowledge, next to the chat) has four tabs:
  Notes, Todos, Plans, Memory. There is no issues surface there.
- The Gitea/Forgejo server provider lists issues, reads issue detail and
  comments, and lists the project's labels (`GET /references/labels`,
  capability `labels`). It has no milestone listing and the issue list read
  takes no label or milestone parameter.

## What should happen

- A fifth tab, Issues, in the knowledge panel: a filtered list of the
  project's issues that stays visible while the chat is used. Clicking a row
  shows the full issue in place: complete body, full comment thread,
  milestone, labels, state, author. Nothing opens externally; an optional
  "Open on <host>" action is the escape hatch.
- The filters include a milestone dropdown and a label dropdown whose
  options come from the host, so the available values are visible without
  being memorized. The same filter component serves the board's filter menu.
- Selection is single per dimension now, on an array-shaped model, so
  multi-select is a later UI change.
- First cut: Gitea and Forgejo only, feature-gated in the provider
  descriptor. The tab and dropdowns are hidden on hosts that cannot answer.

## Decisions already made

| Fork | Decision |
| --- | --- |
| Placement | Tab in the knowledge panel, beside Notes/Todos/Plans/Memory |
| Board consistency | One shared filter component for panel and board |
| Selection | Single-select per dimension, array-shaped state for later multi-select |
| Provider scope | Gitea/Forgejo in this cut, gated by descriptor capabilities |

## Server changes

All in `packages/web/server/lib`.

1. **Milestone listing.** New contract method `listMilestones` on the
   provider resources (`provider-contract.d.ts`), new standard read
   `GET /references/milestones` in `provider-routes.js` under a new
   `milestones` capability, implemented in `gitea/resources.js` (Forgejo
   reuses the Gitea implementation). It returns the project's open and
   closed milestones as `{ name, state }` entries (Gitea's `state=all`),
   capped at the provider's existing collection limits.
2. **Filter parameters on the issue list.** The `/issues/list` read gains
   two optional text parameters, `label` and `milestone`, passed into
   `listIssues`. The Gitea implementation maps them to the host's own
   `label` and `milestone` query parameters. Providers that do not implement
   the parameters ignore them; the UI never sends them there because the
   dropdowns are gated (below).
3. **Descriptor.** Gitea and Forgejo gain the `milestones` capability
   (`labels` is already published). The public descriptor carries it, so the
   UI registry sees it. The publication freeze test
   (`provider-publication-freeze.test.js`) updates with the new field.

## UI changes

All in `packages/ui/src` unless noted.

1. **API surface.** `lib/api/types.ts` gains a milestone choice type and a
   `referenceMilestones(context, project)` method on the source-control
   provider API, beside the existing `referenceLabels`. The issues list
   options gain `label` and `milestone` as single names; the filter model's
   zero-or-one arrays pass their sole entry there, so multi-select later
   needs a server contract change, not a UI rework. `packages/web/src/api/source-control.ts`
   wires the new method to `/references/milestones` and passes the two
   parameters on the list read. The GitLab/GitHub adapters stay unchanged in
   this cut.
2. **Shared filter state and component.** One filter model,
   `{ state, people, labelNames: string[], milestoneNames: string[] }`,
   where each array holds zero or one entry in this cut. One component,
   used by the board's filter menu and by the panel tab: a milestone
   dropdown, a label dropdown, the existing state menu, and the existing
   people menu. The dropdown options come from `referenceMilestones` and
   `referenceLabels`, cached per project with stale-while-revalidate, the
   same cache discipline the reference list uses.
3. **Issues tab in the knowledge panel.** `ProjectContextTab` gains
   `issues`. The tab renders only when the project's connected provider
   publishes both `labels` and `milestones` and a read context exists; it is
   hidden everywhere else, including projects with no connected host. The
   section reuses the neutral issues list read, the existing detail and
   comment reads, and the composer attach path (`resolveComposerReferences`)
   so "Attach to this session" behaves exactly like the board's attach.
   - Rows: number, title, state dot, milestone chip when set.
   - Detail: full body rendered as Markdown, the full comment thread,
     milestone, labels, state and author. No truncation. When the panel is
     wide, list and detail sit side by side, the knowledge panel's existing
     split behavior; narrow, the detail replaces the list with a back
     button, the existing entry-view behavior.
   - Actions: "Attach to this session" and "Open on <host>".
4. **Persistence.** The filter state and the open item persist per project
   in the UI store (the panel already persists its active tab), so the tab
   reopens filtered the way it was left.
5. **Board.** The board's filter menu gains the milestone and label
   dropdowns through the shared component, gated by the same capabilities.
   Its search box and existing menus are unchanged.
6. **i18n.** New strings follow the existing precedent: keys in the English
   message file and in every locale file the i18n test requires, with
   translations where the repo's precedent provides them.

## Failure and edge behavior

- A failed options read (labels or milestones) keeps the last good list with
  a stale hint. A first failure disables the dropdown with an error note.
  An empty dropdown that reads as "the host has no labels" never appears:
  fetch failure is not an authoritative empty answer.
- A failed list read shows the existing failure state, not an empty list.
- One failed dimension (for example milestones) does not block the others
  (labels, state, search).
- A provider that receives `label` or `milestone` it does not implement
  ignores them; the gate means this path is not reachable from the UI in
  this cut.
- Gitea-hosted file uploads inside issue bodies may not load in the panel
  because the Gitea provider has file uploads turned off; they render as
  links. External images render normally.

## Out of scope

- Multi-select label or milestone filtering (the state shape already
  allows it).
- Filter values on GitHub, GitLab and Gerrit.
- PR filtering by label or milestone (issues only; the board's PR tab keeps
  its current filters).
- Label and milestone creation or management.
- Free-text search qualifiers as a substitute for the dropdowns (the search
  box stays as it is).

## Testing

- **Server.** Gitea resource tests: `listMilestones` against the fixture
  API, `listIssues` with `label` and `milestone` parameters. Route tests:
  the new read answers for Gitea and Forgejo, returns the unsupported
  capability response where the capability is off. The publication freeze
  test updates for the new descriptor field.
- **UI.** The shared filter component: options loading, selection, the
  stale and first-failure states. The Issues tab: visibility gating by
  capability, list rows, detail view content, the attach action, filter
  persistence. The board filter menu with the two new dropdowns. i18n key
  coverage through the existing message test.
- **Validation.** `bun run check:changed` passes before any commit
  (type-check, lint, dead code, anti-slop ratchet).

## Verification plan

- Static checks as above.
- Hand-verified against the local Forgejo: the tab appears for a project
  bound to the Forgejo account, the dropdowns list the repo's real labels
  and open milestones, filtering narrows the list, a row opens the full
  body and comments, attach puts the issue into the composer, and the board
  menu shows the same dropdowns.
- Not verified: GitHub and GitLab behavior (out of scope for this cut),
  mobile phone layout beyond the shared panel's existing responsive rules.
