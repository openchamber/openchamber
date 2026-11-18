# Snippets

## Ownership

This module owns snippet files: discovery, CRUD and hashtag expansion. The `/api/config/snippets` routes are registered by `../opencode/config-entity-routes.js`, which also states their request contract.

## Invariants

- Canonical names take precedence over aliases. Project files override global files, and `snippet` overrides `snippets` within a scope.
- YAML aliases retain string coercion for scalar and array values. Descriptions are exposed only when they are primitive strings.
- Rename and scope changes preserve collision checks and cross-device move handling.

## Decisions

### Why YAML roots are boxed before property access

YAML roots can be scalars, arrays or mappings. Boxing preserves JavaScript property-read behavior for every root, including inherited fields, while each accessed value remains unchecked until normalized or validated.
