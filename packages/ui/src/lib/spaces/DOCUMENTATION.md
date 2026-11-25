# Isolated spaces in the shared UI

## Ownership

This module owns the UI's runtime-scoped view of isolated spaces, creation drafts, model-access checks, and lifecycle and apply orchestration. Screens consume its parsed host responses and state. The host owns isolation, credentials, dispatch, code transfer, and filesystem changes; their contract lives in [the server's spaces documentation](../../../../web/server/lib/spaces/DOCUMENTATION.md), especially "The journey", "Dispatcher", "Grants", and "Apply".

## Invariants

- Journey, provider, action, creation-request, and model-choice state belongs to one runtime. Results overtaken by a runtime switch cannot update the next runtime's state. Archive state also resets on a runtime switch, but stays available while the feature is off because archived chats remain.
- A failed list read preserves the last answer and remains distinguishable from an authoritative empty list. An unread provider catalog or an unanswered gatekeeper does not justify a model-access refusal. Unknown network configuration does not mean open internet, and an unread switch-off impact list remains unknown even if switching off succeeds.
- Progress events, locally added creations, and accepted grants supersede list reads that begin before them. A read that begins afterwards is authoritative again; an accepted provider grant also clears that provider's creation failure.
- Session-list marks distinguish complete, partial, stale, and unknown answers. Reconnecting a stream alone cannot establish list freshness. The sidebar includes journey-only creations immediately without treating their absent session lists as stale.
- Provider catalogs load per project before any grant dialog opens because the composer also uses them. Failed provider reads preserve known values and leave never-read projects absent.
- The host gives creation grants before announcing ready. The subsequent journey read supplies grant outcomes that progress events omit; failed grants return the waiting message to the composer. A vanished creation or a runtime reset also releases the message as failed so it cannot wait indefinitely.
- Setup commands use the worktree trust flow for shared repository commands, including reruns. A requested setup wait applies only when the host acknowledges queued commands and ends on completion, failure, interruption, or loss of the running space. Command success is not a prerequisite for sending after that wait.
- `spaceModelOffer` is the one answer to which providers a space may use, for pickers, favorite cycling, the composer's model and the dialogs that start a session there. It reads grants: a provider is in when its grant is held, and Auto and OpenCode's own provider are out, since routing inside has no models of the space's and no grant makes the free models work. `held: null` means unknown and filters nothing but OpenCode's own provider; an unreadable record (`network: null`) is unknown because it lists no grants either way. The send check reads the same unknowns. A stopped space counts only grants its start can say again, so a pasted key needs the user.
- A composer in a space follows the offer as an automatic selection, never a manual one, so the move does not travel to the next folder. It writes only while the space's folder is the active one, except for a draft whose space is still being made. With nothing to move to it keeps the model, marked as refused.
- A send held by "Start and send" goes only with the model shown when that button was pressed, which settles it as the user's choice in the space's folder so the start's own defaults leave it. The send check runs for that model, and a composer that shows another one by then keeps the text.
- Stopped, missing, and unreachable spaces cannot answer polls or messages. The stopped-space check precedes model selection. Their model list is read from the host, and read again from inside once the space runs. Unknown and preparing spaces do not suppress polls; failed, missing, and unreachable spaces offer no new session because it would fail or target an empty folder.
- A missing gatekeeper cannot recover through a start or restart. An unreachable machine offers no actions unless it has left Settings, when deletion can forget the record. Applying work requires a recoverable space and a host project folder that is not known to be gone.
- Lifecycle actions serialize per space within a window. The host's list determines the resulting state even after a failed action, since a failed restart can leave a space stopped. An action failure is shown only while the action still fits the host's current state.
- Partial deletion remains a failed delete with a retry path, including deletion after an apply. Unsaved chats reopen confirmation; deleting them requires the user's explicit "Delete anyway" choice. Archive reads preserve known archived status on failure, and the server enforces archived-chat read-only access independently of this store.
- Apply defaults to a branch named from the space, warns about a working agent without blocking, and deletes afterwards only on request. A refusal that closes the changes route switches the dialog to a branch and leaves the next attempt to the user. A timed-out preview does not establish whether the changes fit; applying fetches the work again rather than reusing preview data.
- Failure paths, chat titles, setup commands and output, and journal hosts are untrusted display text. A journal host cannot trigger an action without the user. Grant and login metadata exposes no token or key; login and key grants replace each other under the provider's identity.
- The journal contains destinations and decisions without request paths, bodies, or secrets. Setup-blocked domains are candidates from the run's time span: the journal has no process identity, so an agent's concurrent request can appear too. An unknown run span produces no candidates.
- Creation progress is not monotonic through the declared step list: image download and tool preparation occur within creating, and creating can follow them again. Optional response fields retain unknown or absent meanings for older hosts; an unfamiliar Docker remedy preserves the place's own explanatory text.

## Decisions

### Why directory routing and not an inferred space target

The `/spaces/<id>/<folder>` directory identifies the same space on both sides of the dispatcher. Directory headers are URI-encoded and marked with their encoding so server readers decode them consistently. VS Code has no isolated-spaces feature and receives no space header.

### Why lightweight runtime detection and not the desktop helper

The routing seam sits under `runtimeFetch`. Reading the bootstrap and registered runtime flags directly keeps runtime-switch dependencies out of that seam.

### Why creation-request tracking stays separate from creation orchestration

Terminal and panel readers need the pending target without loading creation dependencies. Commands wait while the target prepares and then run in the space identified by the branch chip, since running them on the host would affect the wrong machine.

### Why the draft moves on send and not on ready

Moving the draft when creation finishes changes the composer's draft directory and hides text still being typed. The pending request retains the resolved space directory until send; panel content follows that target while panel tabs remain attached to the draft's own folder. The pending promise also has a rejection handler for drafts that are never sent.

### Why running-space access comes from the journey list

The host reads grants from its record and gatekeeper, so the answer survives reloads and agrees across windows. Local provider choices cover creation before the space runs. Providers that the grant dialog cannot help with do not produce a grant refusal; login-only providers have no key option. The pickers list only held providers and the composer moves to one, so the message is not refused at send. The send check stays, for access that changes in between and for unknown access. A grant is per provider, so a picker filters providers and not models.

### Why registries prefill the allowlist

Setup commands commonly download dependencies, and an empty allowlist refuses those downloads. Project root files suggest registries for the Node and Python runtimes present in a space; the user can remove suggestions before creation.

### Why setup-journal matching allows clock slack

The container timestamps its journal and the host timestamps setup runs. A 2-second tolerance accounts for their clocks differing. The blocked-attempt dialog excludes allowed-but-unreachable destinations because its purpose is to offer access changes; only an allowlist refusal can be opened.

### Why lifecycle status waits for fresh lists

The busy status remains until journey and relevant session lists reflect the action, avoiding a transient stopped or unresponsive state with an inappropriate action. An already-running session read can contain restart-era marks, so it finishes before a new read begins. Deletion refreshes the journey, archives, and global session list because the latter's mark can otherwise keep a deleted sidebar group visible.

### Why cache seeding requires a known space

A deleted space's cached chats belong to its archive and their old space prefix returns 404. Space directories wait for current runtime lists before using browser cache; host directories can seed normally.

### Why closing a project preserves active spaces

Closing has no confirmation and must not interrupt an agent's turn. It stops idle running spaces to release memory while keeping their files, using the recorded project folder even if registration disappears. If the fresh list fails, it stops nothing; spaces without a registered project remain discoverable in Settings.

### Why disk labels use decimal units and shared reads

Decimal units match Docker and macOS disk tools, and a no-break space keeps the unit beside its number on narrow screens. Rows mounting together share one in-flight read per place. Sizes are a snapshot refreshed when the list opens; absent or unreadable measurements stay unknown.

### Why Settings visibility includes the feature switch before release

The feature stays hidden until the maintainer releases it. Enabling its settings key makes the places, image, and idle-stop controls accessible beforehand. Settings computes visibility when its pages open, so switching the feature off leaves the current page available until Settings opens again.

### Why the target on screen is selected field by field

The app builds with the React Compiler, which infers what a memo reads. A memo around `activeSpaceTarget()` reads the store unseen and never recomputed, so the pickers kept the first draft's target while tests, built without the compiler, passed.
