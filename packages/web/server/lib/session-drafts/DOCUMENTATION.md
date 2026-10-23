# Session drafts

Drafts of new sessions the user started and left before sending. The server
keeps them for every client, so a draft begun on the desktop shows in the
sidebar on the phone too and opens there with its attachments.

## Storage

- `session-drafts.json` in the OpenChamber data directory: `{ version: 1,
  drafts }`, each draft with its id, directory, project id, text, confirmed
  mentions, attachments and times. A file that does not parse as a store is a
  500, never an empty list.
- Attachment bytes live in `session-drafts/<draft id>/<attachment id>`. An
  attachment is `data` (bytes stored here, from the user's device) or `path`
  (a file on this server, attached by path, stored as the path only).
- Ids are letters, digits, `_`, `.` and `-`, so no id leaves the folder.
- At most 200 drafts, 20 attachments and 25 MB of attachment bytes per draft.

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
