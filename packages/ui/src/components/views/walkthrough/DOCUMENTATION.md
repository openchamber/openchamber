# Walkthrough presentation

## Ownership

This module owns the shared walkthrough reading experience, request controls,
progress display and search-run identity. The context panel and mobile Changes
screen use the same review state with different layouts. Generation and cached
results belong to `useWalkthroughStore`; patch grouping belongs to
`lib/walkthrough/model`.

The [parent view documentation](../DOCUMENTATION.md) owns retained-view
visibility, repository selection, comparison bases, provider capabilities,
published pull request snapshots, comment origins and shared diff search.

## Invariants

- Review controls scope model and language choices to a review. A model selected
  in the blocker saves a walkthrough-task override and clears the previous
  model's level, preserving the models used for commit messages and recaps.
  It also drops the review's own model choice, which outranks the saved one and
  would keep the review blocked.
- A `context-too-small` generation error without sizes is the provider's own
  refusal. Its text names no sizes, and readiness sizes never stand in for them.
- Reopened reviews describe the result on screen. An explicit selection takes
  precedence over the generated result's model or language, which takes
  precedence over request defaults. Without a walkthrough model override,
  requests use the composer's provider and model; the language defaults to the
  interface locale.
- A selected model requires a callable provider. An unresolved authentication
  list permits no providers, preventing an unusable configured model from
  flashing as selected. Login gaps disable Generate without replacing the
  panel with a provider error; models known to lack structured output stay out
  of the choices.
- Readiness belongs to the complete request, including its language instruction
  and model. Changing either requires a new read. An unselected subject loads
  nothing, and a new generated result clears visited stops because it defines
  a new reading path.
- Model and language mismatch banners require a settled read. An in-flight read
  still shows the previous answer, and an absent language on an older result
  provides no evidence of a mismatch.
- Merged hunk patches preserve original `@@` headers so inline comments capture
  real file line numbers. Consecutive hunks form continuous code within each
  file run.
- Search keys distinguish runs in different stops even when their file paths
  match, and include hunk identities so regeneration cannot reuse resolved
  patches from an earlier result. The uncovered-tail sentinel stays distinct
  from generated stop slugs. Match order follows stops, then the uncovered
  tail, with file runs in their reading order.
- Search parses patches only while needed by an open find bar. Layout changes
  rebuild matching, and a match in a collapsed step, collapsed file or the
  uncovered tail opens it before scrolling because its viewers remain unmounted
  while collapsed. Jumping to a collapsed step from the contents list also
  expands it.
- Reviewed files share scope keys with Changes (`useReviewedFilesStore`).
  Marking a file reviewed collapses every run of that file in the walkthrough;
  when the file's hunks change or it leaves the scope, the mark clears and the
  file expands again.
- Export is available only while the panel shows the walkthrough: not behind a
  blocker or the generation stages, even when the store still holds a result. The header's download
  menu folds into More at narrow widths, and the phone offers the same choices
  in its options sheet. The chat's `saveFile` hands the file to the runtime's
  download or share path. Dismissal stays silent; save errors show a toast and
  there is no success toast, since a download cannot report completion.

## Decisions

### Why request fallbacks stay visible and not an empty panel

A previous walkthrough remains readable while another model or language is
requested. A mismatch banner identifies the fallback so the picker cannot
misrepresent the prose, and a generation banner makes a long regeneration
visible beyond the button's change to Cancel.

### Why missing results use Generate and not forced regeneration

Generating a missing model or language variant permits a matching cached
answer discovered during the request. The stale-result regeneration action is
disabled while generation runs because another click aborts and restarts the
same paid work.

### Why Cancel applies to generation and not reads

Source reads have no generation job to cancel. Keeping Cancel tied to generation
prevents it from flickering during model and language changes.

### Why blockers offer a remedy in place and not a Settings detour

Model limitations offer a replacement model beside the refusal and name the
model actually tried, preferring generation-error details over readiness
details. An unsupported server offers Retry here so the read can resume after
an update; unclassified provider errors show a bounded excerpt with the full
message available in the title.

### Why stages describe phases and not elapsed time

Collection and model generation have very different waits, and naming the phase
shows when the model call has begun. Elapsed time adds pressure to work the
reader cannot accelerate, while schema retries remain the same model-wait phase
from the reader's perspective.

### Why stage completion is paced and not replaced immediately

Fast assembly otherwise disappears before its named step can be seen. Stages
advance individually with a minimum display time, including completion, and a
restart immediately returns to its actual earlier phase. Only generation from
an empty panel delays showing its result; regeneration keeps readable content
on screen.

### Why step jumps hold a DOM target and not a smooth scroll

Each stop already has a DOM element, so navigation needs no index-to-pixel
translation. An immediate jump owns the active highlight while mounting diffs
change earlier sections' heights, keeping the destination aligned until user
input or the settle timeout releases it; smooth scrolling lets intermediate
stops steal the highlight.

### Why passive navigation follows headers and not any visible code

A stop becomes active in the viewport's upper band so a long diff does not
oscillate the highlighted step. The contents list follows that row with
`nearest` alignment so an already visible selection does not jolt the list.
Find's line-level navigation for mounted runs follows the parent search contract
and avoids the step jump's header hold.

### Why the contents width is clamped on read and not only on save

The independently resizable panel can become narrower after a width is saved.
The contents column leaves at least half the panel for code and disappears
below the panel threshold; a step menu then preserves position and access to
the full reading path. Its leading-edge resize direction follows RTL layout.

### Why the toolbar measures its own row and not the window

Scope and language change the controls' widths, and the panel's fullscreen and
close buttons occupy space outside the toolbar. Fitting uses the toolbar's
actual space, with consistently toolbar-sized controls; dynamic diff layout
resolves to inline because the narrow walkthrough is read top to bottom.

### Why controls start in the empty state and not twice in the header

Model and language are decided before first generation and appear beside that
action. Once content exists they move to the header or options; blockers retain
header access because changing the model can resolve the refusal.

### Why tooltip wrappers own sizing and not just their buttons

The wrapper keeps disabled controls reachable by tooltip and carries folding
classes so hidden controls leave no gap. Wrapping a picker also keeps tooltip
open state from painting the picker pressed; the More tooltip stays disabled
while its popover is open because the underlying trigger remains interactive.
Mobile picker menus open above the options sheet's layer so they stay reachable.

### Why walkthrough emphasis stays neutral and not status-colored

Importance directs reading attention and observations state facts separately
from explanatory prose. Status colors imply review findings or verdicts, so
weight, neutral pills and explanatory tooltips carry those distinctions. The
in-surface guide explains this distinction where readers encounter the marks.

### Why walkthrough actions use outlines and not accent treatments

Outline actions preserve color for state and avoid competing with nearby primary
actions such as Review or Merge. Outcome-oriented iconography describes the
action; sparkle iconography only identifies the implementation as AI.

### Why orientation uses sticky file names and not full-path captions

Sticky file headers keep the code's identity visible through long hunks. Contents
rows show a single file-name line because truncating a full path at its end
hides the distinguishing name. Step badges expand as pills for multiple digits,
and importance pills match their height so optional emphasis cannot enlarge rows.

### Why uncommitted scopes form a group and not an unqualified Everything

The group makes Everything refer to uncommitted work, preventing confusion with
all branch changes. Branch scope remains available before a base is chosen so
the reader can choose one there.

### Why scope headings use muted labels and not item styling

The dropdown's default heading weight and size make headings look selectable.
Muted metadata styling matches the Select and worktree picker headings and
keeps the distinction visible.

### Why reviewed state tracks files across views and not individual step runs

One file can span multiple walkthrough steps, and readers switch between
Walkthrough and Changes before committing. Storing multi-lane fingerprints
(`meta`, `patchHash`, `walkthroughHash`) per file lets both views share one
reviewed set without falsely invalidating each other, while manual folding
handles hiding a single step or file run without marking it reviewed.
