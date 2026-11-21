# Gitea API fixtures

## Ownership

This folder holds scrubbed API recordings and the fetch double shared by Gitea
and Forgejo tests. The parent Gitea documentation describes the recorded versions
and their verified behavior.

## Invariants

- Routes use `METHOD /path` after `/api/v1`, without the query.
  `/api/forgejo/v1/version` uses `GET /forgejo/version`.
- Routes contain JSON, text, a `Response`, or a synchronous or asynchronous
  handler of the recorded call. Missing routes answer 404. Explicit undefined
  route bodies still fail JSON cloning.
- Calls retain the method, URL, original headers, redirect mode and parsed JSON
  body. The client sends serialized JSON strings and explicitly supplies
  undefined when there is no body. Invalid request JSON fails before recording.
- Responses pass through unchanged. Text uses `text/plain`; other bodies make
  the existing JSON stringify/parse round trip before `Response.json`.

## Decisions

### Why request bodies are serialized JSON strings

The double implements the requests made by the Gitea client, which serializes
write bodies before calling fetch. It does not implement native fetch's stream,
form or binary body handling. Its request type preserves this boundary.

### Why text detection uses the shared string guard

The shared guard also recognizes boxed strings. Keeping that check preserves
the existing plain-text response selection for JavaScript callers.
