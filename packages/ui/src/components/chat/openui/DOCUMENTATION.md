# OpenUI catalog contracts

## Ownership

This folder owns the fixed 48-name catalog and its schema producer. The generator
exports reference text and JSON contracts for the server. Shared program and
action checks live in `packages/web/shared/openui/`.

## Invariants

- The catalog derives signatures, defaults and positional props from the public
  official library extension API.
- Every signature belongs to exactly one resident or optional reference group.
- Stack is the only root. Stack children and table column data support nested
  unconstrained slots; declared component references define all other slots.
- Program inspection uses the official parser and evaluator. It rejects incomplete
  programs, unresolved references, queries, mutations and unsupported action plans.
- Catalog changes require regenerated assets and parser regression checks.

## Decisions

### Why derive the schema from the official library

The official library owns parameter order and defaults. Deriving the host
extensions through its public API keeps generated server contracts aligned with
the selected component schemas.
