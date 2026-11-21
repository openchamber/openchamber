# Gerrit fixtures

## Ownership

This folder owns recorded Gerrit responses and the fetch replacement used by
Gerrit and source-control route tests. The parent module documents the recorded
server versions and fixture scrubbing.

## Invariants

- The only imported data is `api.json`. Request URLs, options and route overrides
  come from tests and the Gerrit client. Request bodies are JSON strings;
  malformed JSON rejects before a call is recorded.
- Missing options retain GET, empty headers and an undefined body and redirect.
  The client intentionally passes an explicit undefined body for reads.
- Only own route keys match. Authenticated paths drop `/a` for matching.
  Missing routes answer a plain-text 404.
- Routes contain JSON answers, Responses or synchronous or asynchronous handlers.
  Responses pass through unchanged; other answers receive Gerrit's XSSI prefix.
  JSON object fields may be undefined, as in the ready-state test override.
- Recorded refusals retain their status and body. Their default content type is
  plain text. Patch responses retain the base64 content-encoding header.

## Decisions

### Why request options describe JSON text

The replacement records the Gerrit client's serialized JSON body directly.
Accepting arbitrary fetch body streams would claim support that the existing
`JSON.parse` call does not provide.
