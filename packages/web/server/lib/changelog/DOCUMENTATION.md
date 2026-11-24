# Update release notes

## Ownership

This module reads release-note feeds for the update dialog and Settings About.
Release generation belongs to `scripts/changelog`; server update selection
belongs to `../package-manager.js`.

## Invariants

- Network failures, missing feeds and unexpected shapes leave updates available
  without notes. Empty results mean no matching notes; null means a failed read.
- Feed fields are normalized at the network boundary. Releases lacking a valid
  version or date and website entries lacking groups are left out.
- Update notes cover the installed version exclusively through the offered
  version inclusively, newest first. About shows that range when moving forward
  and the selected version alone for its own notes or a return from Canary.
- Version order follows semver precedence, including numeric prerelease
  identifiers, so dated Canary runs order within a release and before its Stable
  version. Canary notes use the nightly feed with the same Markdown section
  shape as release notes.

## Decisions

### Why the website or mirror precedes GitHub and not the reverse

The website keeps its last good release feed through GitHub outages and the
Canary mirror provides a separate download path. A bounded first-source wait
leaves the remaining request budget for GitHub fallback.

### Why feed values retain JSON coercion

The feeds are JSON documents, but text fields and bullet items need not be
strings. Normalization keeps the existing `String` conversion, trimming only
text fields, and treats non-array bullet groups as empty. Object guards handle
field access without imposing a stricter feed schema. Missing values remain
distinct from explicit null values until normalization.
