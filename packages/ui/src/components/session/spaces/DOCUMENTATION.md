# Isolated-space UI

## Ownership

This module owns creation, access grants, state presentation, setup output, apply
and delete dialogs for isolated spaces. `lib/spaces` and the host own lifecycle,
credential delivery, network enforcement and filesystem operations. Sidebar work
rows consume these controls; they do not implement their security decisions.

## Invariants

- Space surfaces mount behind the feature switch in desktop, web and mobile.
  VS Code mounts none. Place checks start when creation opens, so startup and
  entry visibility perform no speculative environment probes.
- A failed change-list read defaults to a clean start, so code the user has not
  seen cannot enter the space. Shared setup commands require trust before creation.
  Registry domains seed the allowlist once per opening while it is untouched,
  because setup dependency downloads otherwise all fail.
- Late place and provider answers may fill untouched defaults, but never replace
  user choices. The first message uses a model actually granted to the space.
  The selected machine states where its granted credentials are stored.
- Model access distinguishes a host login, a saved provider key, an environment
  variable name and a one-time pasted key. Saved keys are reread at each start,
  variable grants retain the name for restarts, and pasted keys persist nowhere.
  Custom providers use host configuration and request no pasted credentials.
- Login-only providers offer only a transferable host login. Failed or unread
  login discovery offers no login and cannot report signed-out success. A refused
  login grant refreshes the host answer; a token without expiry carries the
  stronger warning because the space retains it until deletion.
- Provider catalogs and login state refresh whenever a grant dialog opens, since
  Settings may have changed. A row follows late defaults only until its source is
  touched. Opening for another space drops typed credentials and targets the
  requested provider's row.
- Access grants apply immediately and cannot be revoked through this dialog.
  Granted domains have no remove action. Stopped spaces accept no grants.
- The gatekeeper journal exists only since its last start. Access and setup views
  read it on opening or explicit refresh and never poll it; an empty journal must
  remain distinguishable from lost history or an unavailable read. Domain failures
  stay attached to the domain whose grant failed.
- Docker setup polls only while an action the user started is running on screen.
  Completion or a lost host ends polling and rechecks the place, which owns the
  resulting availability answer.
- Paths, names, setup commands and output from a space render as plain text.
  Setup failures list refused domains only when the journal confirms them; an
  unavailable journal cannot imply that no domain was blocked.
- An unknown network state is neutral. It cannot display the success tone of a
  confirmed allowlist or the warning tone of confirmed open-internet access.
- Deleting first saves the space's chats to Archive. A failed save keeps the space
  and asks again with Delete anyway, naming oversized chats separately. Delete
  confirmation retains its displayed space through its closing animation.
- Apply defaults to retaining a space while an agent is working, so completion
  cannot interrupt the turn. A successful apply and failed subsequent deletion
  remain separate outcomes. A stopped space with no network filter cannot restart.
- Unreachable or stopped spaces hold transcript loading because messages live
  inside them and a read would wait for a timeout. A successful start resumes
  loading from authoritative lifecycle state.
- Incomplete session answers retain last-known sessions and show their partial
  state. Failed setup is a warning while the space otherwise works; stopped is a
  resting state. A single status mark takes the highest severity and exposes the
  full explanation and repair in a tooltip or the phone's actions sheet.
- The session header names the space a session works in, with its icon, where it
  would otherwise name the branch, since a space's branch is the project's.
- "Run setup again" is offered only in a project with setup commands. The menu
  reads the project's setup each time it opens; a failed read offers the action.
- "Start and send" on the stopped-space toast starts the space and holds one send
  for the composer it was pressed in (`lib/spaces/space-send.ts`). The send goes
  once the host lists the space running and the composer has a model. A model the
  space refuses is first replaced by the session's own model, else by a granted one.
  Another draft on screen or a failed start drops the send and keeps the text.

## Decisions

### Why space deletion opens a separate confirmation

The confirmation offers Apply first and explains what disappears. Menus and sheets
only open it, so a list interaction cannot delete the space directly.

### Why stopped is a word on the work row

A square status glyph reads as a Stop button. The word uses the row's time slot,
while the tooltip and phone sheet expose the available Start action.

### Why "Run setup again" stays hidden until the setup read answers

An item that appears late pushes Stop and Delete down, which a user aiming for
Stop survives. An item shown first and dropped after the read would pull Delete up
under the cursor, so the menu waits for the answer and keeps no cache between openings.

### Why "Start and send" waits on composer state and not on the start's promise

The composer's model is wrong until the space answers: a stopped space's session
cannot load, so it shows the default model, and a draft's model list comes from
OpenCode inside the space. A send right after the start went out with that model
and was refused, so the held send runs from an effect once the composer is ready.
