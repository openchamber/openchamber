# Walkthrough client

## Ownership

This module owns the walkthrough wire contract, HTTP reads and mutations, and pure presentation model. The server owns generation, hunk identity and the current diff; the panel owns rendering and navigation.

## Invariants

- Hunk IDs are opaque and resolve only against the server's current index. Missing anchors mark changed code, and uncovered current hunks remain in the tail; clients never invent replacement identity.
- A failed authoritative read preserves the existing walkthrough. Non-JSON 2xx or 404 responses identify an unsupported route, while non-JSON 5xx responses retain their own failure. A revision ignored by an older server cannot satisfy a revision-specific read.
- Leaving the panel does not cancel paid generation. Explicit cancellation owns that action, and progress polling reads server memory instead of rerunning the full Git pipeline.
- Consecutive hunks of one file share a diff block and one file header so the reader sees continuous code. Phase labels describe only work with meaningful wait time; observations remain facts accepted with the change, separate from findings.
