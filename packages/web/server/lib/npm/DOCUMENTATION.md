# npm registry

## Ownership

This module owns reads of npm package metadata: the registry and credentials a request goes to, and the cached package lookups built on that.

## Modules

- `packages/web/server/lib/npm/npm-registry-config.js`: resolves npm package metadata requests from inherited npm registry settings or the user's `.npmrc`, including scoped registries and matching bearer/basic HTTP authentication.
