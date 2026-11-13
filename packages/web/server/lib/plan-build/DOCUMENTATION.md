# Native Plan → Build handoff

## Ownership

The OpenChamber server turns a successful, completed OpenCode Plan turn into a native OpenCode form (`session.form.create`). OpenCode holds the pending question and publishes its events to every connected client. The server intercepts answers to the handoff form before generic `/api/*` proxying, switches the owning session to a primary Build agent on approval and sends the implementation request in the same conversation.

## Invariants

- This feature is **server-side**. Web, Electron, hosted mobile, and Capacitor mobile all use OpenCode's existing question presentation and reply route; no new client action or UI bundle is necessary. A VS Code extension connected directly to OpenCode, rather than an OpenChamber host, does not receive the server-owned handoff.
- The OpenCode watcher gives server consumers **translated** `session.idle` events, not raw `session.execution.succeeded`. Aborted or failed turns, subagents, unfinished replies, and sessions outside Plan are not eligible.
- The last completed assistant message identifies the finished Plan turn. Forms carry that message ID and a metadata marker. An existing pending form suppresses duplicate offers. A per-session guard prevents simultaneous creation and a per-form guard prevents two devices submitting the same action twice.
- The form opens with Yes and No options. Choosing Yes keeps it to one step; choosing No activates a required free-text field for changes. The stock question dock displays this as a second step, and the server sends the entered feedback as a new Plan turn before another handoff is offered. The chat composer remains available for native model and thinking-level selection. Stock OpenChamber clients apply their composer selection to the session before submitting the form answer (`applyFormSelection`), so approval uses the model and variant selected at submission time. No model catalogue lookup or custom model question is needed. Agent *IDs*, not display names, are passed to OpenCode. A Build agent must be a primary agent; internal compaction/title/summary agents cannot be selected as fallback builders.
- Missing Build agents do not settle the form. The server also resolves OpenChamber Auto through the existing router because the special form reply bypasses the regular routing rewrite. Failure before settlement restores the previous agent and any Auto-resolved model. If sending the Build request fails after the form was settled, the server restores Plan and re-creates the form for another attempt.
- OpenCode's pending forms are ephemeral across an **OpenCode process restart**. An already-created pending question may disappear after that restart; a new successful Plan turn generates a new question. Browser or client reconnects without an OpenCode restart retain pending forms.

## Why native forms rather than a custom message action?

The earlier custom message button was packaged in the web frontend, so installed desktop and mobile clients did not receive it when switching servers. Native `session.form.create`/`session.form.reply` works with the existing question dock on every client using the host. Its presentation and submit controls are defined by each client, not by this server feature; Codex's exact one-click layout cannot be imposed on older binaries remotely.

The server does not receive unsubmitted composer picks from other devices. Approving a question uses the selection the submitting client applies to that session first; an API-only reply uses the session's last stored model and effort. Choosing No restores the Plan agent even if the user switched agents in the composer and submits the written feedback as the next Plan message. A blank No answer cannot be submitted. An accepted answer whose Plan follow-up fails reoffers the form.

On the installed native question dock, fields activated by `when` appear on the next question step. Changing the No row into a text input within the same step would require shipping a client UI change; the server-only protocol cannot control that presentation.
