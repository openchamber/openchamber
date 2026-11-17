# Overview availability

## Ownership

This module owns runtime availability of the Overview page. The page itself
belongs to `packages/ui/src/components/overview`.

## Invariants

- An unset `OPENCHAMBER_OVERVIEW_ENABLED` leaves Overview absent from navigation,
  commands and mounted UI while the page is under design. The settings payload
  reports `overviewFeatureAvailable` from the running server.

## Decisions

### Why the flag is read per call and not during the build

The process environment decides availability, so a release can carry the code
without exposing the page and without requiring a separately configured build.
