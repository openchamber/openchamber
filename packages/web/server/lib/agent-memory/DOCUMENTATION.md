# Agent memory

## Ownership

This module owns global and project memory storage and the `memory.*` action dispatcher. Project resolution supplies the canonical project identity. User-authored notes belong to session knowledge.

## Invariants

- A missing file is authoritative empty. An existing file must parse as an object with an `entries` array before entry sanitization.
- Invalid documents fail reads and mutations without modifying the file. Reads never repair, quarantine or write back storage.
- Entry sanitization remains tolerant of legacy fields and versions. Valid empty arrays remain readable.
- Mutations serialize per scope within a runtime and commit through a temporary file and rename. A failed write preserves the previous file; failed mutations release their lock.
- A failed scope leaves the healthy scope readable. `readAll` failure flags and dispatcher unavailable fields distinguish failure from empty success.
- Restatements deliberately replace by exact title or sufficient wording overlap. Explicit rewrites target an id; related-entry responses leave consolidation to the caller.

## Decisions

### Why document validation precedes entry sanitization

The sanitizer tolerates malformed individual entries. Applying that tolerance to a missing or non-array collection would grant corrupt storage the authority of an empty store and let the next save overwrite it. Document rejection preserves the bytes for recovery while keeping legacy-entry tolerance.
