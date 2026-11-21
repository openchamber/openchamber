# npm registry

## Ownership

This module owns reads of npm package metadata: the registry and credentials a request goes to, and the cached package lookups built on that.

## Invariants

- Registry selection reads inherited npm environment variables and the user's `.npmrc`. Scoped registries take precedence over general registries. Credentials are sent in headers and removed from request URLs.
- Registry JSON remains unchecked until use. Dist tags accept string values only; versions accept the keys of a non-array object. Missing or invalid metadata fields produce empty collections.
- Successful lookups and 404 responses are cached for 1 hour. Other failures remain retryable. Forced refresh bypasses both the cache and in-flight deduplication.
- The user agent reads the checkout's root package version. A missing or unreadable checkout manifest, including JSON null, uses `dev`; a readable non-null value without a string version uses `0.0.0`.

## Decisions

### Why metadata keeps input guards

Registry responses and the checkout manifest are external JSON, so their types describe JSON values until the existing object and string checks narrow them. Thrown failures may carry a non-string message; error formatting retains that value through the existing nullish fallback and string conversion.
