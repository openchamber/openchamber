# Routing client

## Ownership

This module owns routing-state parsing, Auto selection notices and context-limit lookup. The server owns routing configuration, classifier credentials and replacing the Auto sentinel before OpenCode admission.

## Invariants

- The Auto sentinel never names a real OpenCode provider. An unavailable routing route reports `available: false`, while failed reads throw; a transport failure cannot become an empty routing configuration.
- Unknown classification sources drop independently so a newer server cannot invalidate otherwise readable state. The full classification view wins over the legacy classifier shape, and omitted optional fields retain compatibility with older servers that reject unsupported save fields.
- Endpoint keys remain on the server. A string replaces a custom key, null removes it, and omission preserves it; an endpoint test saves nothing. Environment-pinned endpoints remain read-only.
- Context readouts prefer the session's recorded model because both manual switches and Auto decisions arrive before a reply. Assistant-model fallback uses the same OpenCode catalog as the composer; an unrelated models.dev window cannot change the displayed limit. Primitive model keys avoid per-part selector updates.
- Loss of a working classification provider explains why stale Auto selection changes and offers configuration. User-disabled Auto and enterprise refusal do not offer the same corrective action.
