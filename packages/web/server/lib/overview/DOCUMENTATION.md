# Overview availability

## Ownership

This module owns runtime availability of the Overview page. The page itself
belongs to `packages/ui/src/components/overview`.

## Invariants

- An unset `OPENCHAMBER_OVERVIEW_ENABLED` leaves Overview absent from navigation,
  commands and mounted UI while the page is under design. The settings payload
  reports `overviewFeatureAvailable` from the running server.
- The module has no imports. Its only external input is
  `process.env.OPENCHAMBER_OVERVIEW_ENABLED`. A string guard validates this
  environment boundary before trimming and lowercasing. Only `1`, `true`, `yes`
  and `on` enable Overview; missing, empty and other values return `false`.

## Decisions

### Why the flag is read per call and not during the build

The process environment decides availability, so a release can carry the code
without exposing the page and without requiring a separately configured build.
