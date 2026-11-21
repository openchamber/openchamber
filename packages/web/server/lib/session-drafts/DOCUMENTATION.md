# Session drafts

Drafts of new sessions the user started and left before sending. The server
keeps them for every client, so a draft begun on the desktop shows in the
sidebar on the phone too and opens there with its attachments.

## Storage

- `session-drafts.json` in the OpenChamber data directory: `{ version: 1,
  drafts }`, each draft with its id, directory, project id, optional target folder id, text, confirmed
  mentions, attachments and times. A file that does not parse as a store is a
  500, never an empty list.
- Attachment bytes live in `session-drafts/<draft id>/<attachment id>`. An
  attachment is `data` (bytes stored here, from the user's device) or `path`
  (a file on this server, attached by path, stored as the path only).
- Ids are letters, digits, `_`, `.` and `-`, so no id leaves the folder.
- At most 200 drafts, 20 attachments and 25 MB of attachment bytes per draft.

## Invariants

- Draft and attachment ids start with a letter or digit, excluding `.` and
  `..`, and destination paths are checked again before writing bytes. An id
  cannot escape the draft folder even if an earlier validator changes.
- Request limits account for base64's extra third of attachment size. Client
  responses expose server paths only for path attachments and omit the private
  storage location of uploaded bytes.

## Routes

- `GET /api/session-drafts`: every draft, without where the bytes live.
- `PUT /api/session-drafts/:id`: creates or replaces a draft. An attachment
  carries `dataUrl` when its bytes are new, `path` for a server file, or only
  its id to keep what the draft already holds; anything else is dropped, and
  files no longer listed are removed.
- `DELETE /api/session-drafts/:id`: removes the draft and its files.
- `GET /api/session-drafts/:id/attachments/:attachmentId`: a stored
  attachment's bytes.

Writes are serialized, and each one that changes the store sends
`openchamber:session-drafts-changed` to every connected client, which reads
the drafts again. The client side is `packages/ui/src/stores/useSessionDraftsStore.ts`
and the sidebar's Drafts section (`packages/ui/src/components/session/sidebar/DOCUMENTATION.md`).
VS Code has no OpenChamber server and does not use these routes.
If the change callback throws, the completed write remains saved and clients
read it on their next load.

## TypeScript conversion boundary

`routes.ts` imports Express for its JSON middleware and receives the Express app
from `server-frame/feature-routes-runtime.js`. Its conversion uses
`../shared/http-contracts.js` for the app, request, response and handlers.
`../shared/express.d.ts` supplies the existing factory and JSON middleware
declarations. Request bodies retain their external types until validated.
Stored draft and attachment types are inferred from their Zod schemas. Files
must pass those schemas before their contents enter the typed store.
The missing-file error guard checks unknown filesystem failures, including
objects and functions carrying an `ENOENT` code.
