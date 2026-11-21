# Managed quota credentials

## Ownership

This folder owns normalization and local storage for exe.dev, Cursor and
ZenMux credentials. Quota routes own HTTP validation against each provider.
Provider implementations own credential discovery and usage requests.

## Invariants

- File contents and HTTP bodies are JSON inputs. A missing field, a non-string
  secret or a string containing CR or LF normalizes to an empty string.
  Strings are trimmed. An empty required secret returns `null`.
- Cursor accepts either token and always returns both token fields, with an
  absent token represented by an empty string. Other providers return only
  their required secret field.
- Status responses contain no secret. An unconfigured status contains only
  `configured: false`; a configured Cursor status also reports whether its
  refresh token is present.
- `OPENCHAMBER_DATA_DIR` selects the storage root when non-empty; otherwise
  storage uses `~/.config/openchamber/quota`. Only the three managed provider
  IDs may select a credential path.
- Missing files return `null` without warning. Other read or normalization
  failures warn without exposing the credential and return `null`.
- Writes use a temporary file and atomic rename with owner-only permissions.
  Existing directories keep their permissions. Temporary-file cleanup runs
  after both success and failure.
- Deletes ignore only `ENOENT`. Legacy Go cleanup propagates other failures;
  legacy Ollama cleanup warns and continues. Neither reads the obsolete secret.

## Decisions

### Why JSON input and provider-specific credential results

Normalization receives the JSON values read from disk or supplied by HTTP,
including malformed field values. Successful results have provider-specific
string fields. The JSON contract describes the input before validation and
does not widen the stored credential contract.

### Why runtime guards remain

Secret guards validate external field types and reject line breaks. The
credential-object guard makes property reads safe for primitive and array JSON
inputs, which have no credential fields. The missing-file guard checks thrown
filesystem errors without assuming every thrown value is a Node error.
