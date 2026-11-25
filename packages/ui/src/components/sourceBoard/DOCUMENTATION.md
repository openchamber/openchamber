# Source board

## Ownership

This module owns the desktop board, the phone board page, their project and repository scope, item focus, and the actions offered for the previewed item. The neighbouring `references` module owns shared lists, previews, caches, and live item status. Runtime source-control and tracker APIs own host reads and writes; the Git screen owns its separate repository selection.

## Invariants

- The board remembers its own project and repository. Browsing a different scope leaves the app's current project and Git selection unchanged; opening work or Changes can move the app.
- An established repository root remains readable during nested discovery and is the default choice. Submodules and nested checkouts remain selectable beside it. All-repository listing is available only under a root that is not a repository and on a runtime that supports it, avoiding duplicate root items.
- Pending discovery, failed discovery, and pending tracker status remain distinct from an authoritative empty result. A chosen tracker waits for its status before falling back, preventing a flash of the repository tab. Only connected trackers get tabs, and project pickers remain reachable on loading and no-source screens.
- Across-repository results retain their originating folder for reads and writes. The list discloses omitted repositories and their reasons, naming the affected provider or the provider the search asked, so partial results cannot appear complete.
- Link resolution prefers a matching origin over another matching remote. A possible origin still loading delays fallback to a fork's upstream; failed remote reads and pending reads remain distinguishable.
- A focused repository link searches the project's candidate repositories, including submodules under an established root. Pending focus survives discovery and source remounts; when focus selects all repositories, that choice is remembered.
- A focus request resolves its item separately from the list search, preserving the user's search. Only the matching result gets previewed and followed. Each request is consumed once, so a previous result cannot satisfy a newer request or reopen after the user moves on.
- A linked repository item outside the project's ownership is read only through a matching host account. Its read context never becomes a mutation context. A linked item can still be attached to the composer.
- Changes and Walkthrough use the item's repository and key requests by the folder that reads it. Nested repositories override the view's repository without altering the Git selection. Both links use the selected revision and are absent when the host cannot serve diffs.
- On the phone, Changes reads through the folder the app shows and uses its normalized request key. A PR in a sibling repository opens through the project's root with a repository override; another project's PR opens a project draft first. The phone offers no Walkthrough side panel.
- Attachment actions place chips on the current composer's draft without sending a message. A new-session draft opens before receiving its chips. A tracker item's starting project follows its container mapping, then the mapping default, then the board's project, with a user override available.
- A worktree requires the project itself to be a repository. Stacking requires a branch in the PR's own repository; a fork branch or revision-only head cannot supply that branch.
- Every user action gets a fresh idempotency key. Retries of that action reuse its key, while a separate click gets a new key.
- Change-request edits and verdicts name the head shown in the preview, allowing a push since that read to refuse the write. Votes use the latest revision SHA from the same context as the vote labels, because a listed item's head can lag an upload. Older revisions expose no vote action, and labels the account cannot vote on are omitted.
- Reply text remains until the host accepts it. A successful verdict with a failed text post keeps the text available to retry. Drafts are keyed by item so text cannot carry into another item's reply.
- Successful mutations refresh the item and list. Refused reviews and thread writes refresh too, because the refusal can mean the host changed since the preview was read. Locked discussions accept comments only from viewers allowed to update them.
- Submission requirements hold Submit until read and while unsatisfied, unevaluated, unreadable, or rejected by the host's mergeability result. Unknown merge methods are omitted so a newer server cannot break this client's actions; the remembered method applies only while allowed here.
- Landing counts include only open layers below the selected change, bottom first. A numbered GitHub stack lands its lower layers together, and submit lands a change-based relation chain; a GitLab branch chain merges one request at a time.
- Label and reviewer pickers preserve selected entries outside the host's listed page. Reviewers cannot be edited until detail establishes the current set. Selection uses the choice's original id because the command list trims the value it returns.
- Tracker mappings are scoped to tracker and account while the board is open. Workflow states follow category order, then position and name. Tracker product names remain untranslated.

## Decisions

### Why keep the desktop board mounted and not remount on every open

Keeping the board mounted preserves selection, search, scroll positions, and an unfinished reply. Hidden boards stop following listed items; reopening restores search focus.

### Why revalidate on return and not rely only on live item status

Live status updates existing items, while revalidation also finds items that join or leave a list after host or agent activity. While visible, the board revalidates stale reads on opening, window return, and source-control activity; explicit refresh bypasses short-lived host answers for the preview or list and its checks.

### Why fall back to the browser only for newly opened Tracker tabs

A click-opened tab can fall back until it first displays its item. Restored tabs and tabs that already loaded report later failures in place, preventing an unsolicited browser opening; unsupported links or surfaces and missing runtimes use the browser directly, as do Cmd or Ctrl clicks.

### Why ask extensions' link claims before the browser and not only in messages

A link the board cannot show reaches the browser only after an extension's `open` claim (`contributes.links`) had its chance through `runGuestLink`, the chat's own route, so a link an extension claims opens it the same way from a message, a reference chip, Work status's Context sources or the sidebar. Only extensions allowed in the screen's project claim, a dialog extension too, since the extension's UI is hidden in other projects; a message keeps the whole catalog. A rail panel opens beside the chat on screen, as the board's tab does, and never under the row's own directory, whose panel may not be on screen. `useOpenTrackerItem` says where the link went, so Work status on the phone stays open when the extension's panel is a tab of its own drawer. An `attach` claim keeps the browser: its composer chip would land in whichever composer is mounted, which need not be the row's session. The app's own readers still win, a Cmd or Ctrl click still opens the browser, and Shift or Alt skips the claim as it does in a message.

### Why put error boundaries inside the board and not around the whole phone page

The desktop overlay contains its own recovery screen. The phone header stays outside the failing content because its close button is the way to leave the page on iOS.

### Why load check details on demand and not for every listed PR

Lists need totals, while individual runs, steps, and annotations are read for the opened PR. The dialog shares the PR panel's cache, refreshes on every open, and polls while checks run, so either view supplies the other's cached details.

### Why commit picker selections on close and not after each click

The host receives one replacement set for a group of label, reviewer or assignee choices. This keeps several clicks within a single edit. Only the user's own picks are applied to the set the host last answered, so a refresh landing while the picker is open is never undone; the assignee pencil stays busy until the saved set is read back. The assignee pencil appears only when the descriptor publishes `features.issueAssignees` and the detail does not answer `writeAccess: false`; an unknown write access keeps it, because only an explicit denial hides a control.

### Why the close reasons need `issueCloseReasonWrite` and not `issueCloseReason`

An extension or an older server can publish `issueCloseReason` while its close route drops the reason, so the issue would close with another one. Only GitHub publishes the write; everywhere else the menu keeps the single Close.

### Why a denied viewer keeps Close unless the host also refuses edits

Repository write access says nothing about the item's author, who may close, reopen and change the draft state of their own item. `writeAccess: false` alone hides the close reasons and the assignee editor. The menu goes away, leaving a plain state pill, only when the detail also answers `viewerCanUpdate: false` (`canChangeReferenceState`).

### Why use phone bottom sheets and not scope popups

A popup cannot scroll far enough for a long project or repository list on the phone. Tracker accounts share the container menu because accounts are few and switched rarely.

### Why collapse the narrow list and not squeeze the preview

A narrow board puts the list in a dropdown and gives search its own row. Column sizing caps the remembered width at 60 percent and bounds its minimum by half the available board; the repository picker can truncate, and the fixed-width kind switch precedes variable-width scope names so changing scope cannot shift it.

### Why share the phone scroller and not preserve the preview's offset

The list and preview occupy the same phone page. Returning restores the list's offset, while each newly opened preview starts at the top.
