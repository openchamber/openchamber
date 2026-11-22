# Session Journal

A service-only extension that is told what happens in your sessions and writes
it down. It declares `contributes.sessionEvents` next to its
`contributes.service`, so OpenChamber posts each event it subscribed to
(`POST /session-events`) to the service, from every project, whether or not a
window is open. There is no panel: the extension's whole surface is the file it
keeps.

The service (`service/main.ts`, built to `service/main.js`) reads each request
with `readSessionEventRequest`, appends it as one JSON line to
`~/.openchamber-session-events.log`, and answers `{ "ok": true }`. The manifest
asks for all four events and for their content, so each line carries what the
agent said or asked, not only that it did.

## Install and watch

1. In **Settings → Extensions**, add this folder.
2. In the approval dialog, allow the local service. The dialog lists the four
   events under it and a separate line, **Read what the agent says in the
   background**, for the content. Nothing arrives before you allow both.
3. In a terminal, `tail -f ~/.openchamber-session-events.log`.
4. Run a turn in any project and watch a `turn-finished` line land when the
   agent is done; ask it something that makes it ask you back and watch
   `question-asked`; make it ask permission and watch `permission-asked`.

Pause the extension and the lines stop; resume it and they come back.

## What a line holds

```json
{"id":"evt_…","type":"turn-finished","at":1730000000000,
 "session":{"id":"ses_…","parentId":null},
 "project":{"directory":"/Users/me/repo"},
 "linked":[{"id":"linear:OPE-367","kind":"linear","url":"https://linear.app/…","provider":"linear","identifier":"OPE-367"}],
 "content":{"type":"turn-finished","sessionTitle":"Fix the parser","reply":"Done. The parser now…","replyTruncated":false}}
```

`linked` is what you attached to the session: identifiers and links, never
titles. `content` is there only with the content line approved; a reply longer
than 64,000 characters is cut and `replyTruncated` says so. A `turn-failed`
line carries the error instead of a reply, `permission-asked` the action, its
resources and the agent's note, `question-asked` the form's fields or the
page's title.

## Choosing projects

OpenChamber sends every project's events and leaves the choice to the
extension. This service reads `SESSION_JOURNAL_PROJECTS`, a comma-separated
list of project directories, and journals only those; unset, it journals all
of them. A real extension would keep that choice in its own settings or
storage and compare `event.project.directory` against it the same way.

## Rebuild

```bash
bun packages/sdk/scripts/bundle-guest.ts --node packages/sdk/examples/session-events-log/service/main.ts packages/sdk/examples/session-events-log/service/main.js
```

`scripts/session-events-example.test.ts` runs the built service the way
OpenChamber does and checks each event type lands in the journal.
