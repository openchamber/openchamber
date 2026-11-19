# GitHub repository resolution

## Ownership

This folder parses Git remotes, applies the neighboring host-trust policy and
resolves the repository's parent/source network through Octokit. Git execution,
credentials and HTTP resource mapping remain owned by their existing modules.

## Invariants

- Remote input retains JavaScript string coercion. Missing or unreadable remotes
  return both fields as null; an untrusted host retains its remote URL.
- Network entries retain origin-first order and inherit the origin host.
  Parent/source duplicates are compared by normalized host, owner and name.
- Metadata caching remains credential-scoped, bounded to 200 entries and fresh
  for 5 minutes. Clients without a cache identity do not reuse metadata.
- Strict reads reject malformed metadata and propagate provider failures.
  Best-effort reads suppress 403/404 and directory-resolution failures.

## Decisions

### Why provider checks retain their original acceptance rules

Octokit supplies the repository response type; it does not replace the existing
runtime checks. Related-repository validation accepts boxed strings through its
string tag check, while cache-key normalization accepts only primitive strings.
Keeping both checks preserves malformed-response and best-effort behavior.

### Why repository types follow their owning boundaries

Parsed remotes have validated, required coordinates and URLs. Provider metadata
uses Octokit's response type without asserting that the strict validation
establishes a complete repository response. External errors retain their original
status comparisons through a property guard.
