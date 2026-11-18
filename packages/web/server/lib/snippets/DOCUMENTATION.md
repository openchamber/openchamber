# Snippets

## Ownership

This module owns snippet files: discovery, CRUD and hashtag expansion. The `/api/config/snippets` routes are registered by `../opencode/config-entity-routes.js`, which also states their request contract.

## Modules

- `packages/web/server/lib/snippets/snippets.js`: opencode-snippets-compatible snippet file CRUD, discovery, and hashtag expansion.
