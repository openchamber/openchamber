# Spaces client

## Ownership

This module owns the parsed front-door Spaces contract, place choice, creation
and repair orchestration, and the window's Spaces journey state. The server's
Spaces and hostd modules own execution, isolation, grants and passkey verification.
Shared screens use runtimeFetch through spaces-api; they do not call hostd or
read credentials directly.

## Invariants

- Web, Electron, hosted mobile and Capacitor use the connected server's routes.
  VS Code has no Spaces entry point. Feature-off behavior remains unchanged.
- Missing or unknown place kinds parse as Docker for older servers. Missing or
  malformed root activation metadata never authorizes root creation.
- Automatic place choice considers isolated host users first, then Docker.
  Root requires an explicit selection even when every other place is down.
- Each root create, start and restart obtains a fresh challenge. WebAuthn uses
  required user verification, the server's rpID and only credentials approved
  for the exact current origin. A refused origin names the approved addresses.
- Shared start/restart first await the root-warning dialog mounted beside the
  existing Spaces dialogs on web, desktop and mobile. Dismissal or unmount
  cancels the operation before it requests a challenge.
- Root assertions and approval codes remain in memory. They are never persisted,
  logged or retried automatically. A cancelled ceremony sends no create/start.
- Creation sends the same request it challenged, with the server-assigned id and
  the assertion. A draft and group appear only after the create is accepted.
  Runtime changes invalidate a multi-step root operation before its next write.
- Passkey approval signs with an existing UI sign-in passkey. The response means
  awaiting terminal confirmation; only a later server list establishes approval.
  Revocation is a root terminal command, with no client mutation endpoint.
- MCP grants contain a connection id and name, without credentials or window
  URLs. They preserve unrelated model access failures and have no revoke action.
  Missing or unknown access keeps the re-grant action available.
  Docker screens never query protected MCP status or offer an MCP grant button.
- Root spaces have no isolation guarantee. Screens explicitly describe root's
  access to all files and credentials, and offer no network restriction control.

## Decisions

### Why root uses an origin-filtered credential list

An rpID can cover several addresses while each root approval binds an exact
origin. Filtering before WebAuthn prevents a chooser from offering a key that
the root component must reject, and avoids an empty allowCredentials list
falling through to discoverable credentials.

### Why root confirmation lives in shared orchestration

Start is reachable from row actions, repair notices and the apply/access dialogs.
The shared repair operation covers every caller, including the warning before
the native prompt. Creation retains its existing draft lifecycle after the
native ceremony succeeds.

### Why root Settings does not poll

Terminal confirmation is a separate root decision. The fingerprint remains
visible until an explicit refresh finds its fingerprint and exact origin among
approved keys. The approval action restores code entry after terminal rejection
or expiry. Older servers without a root place are not asked for the new passkey
routes. Missing root spaces remain listed for cleanup even after their project
or place disappears.

### Why MCP grants use protected status

The protected MCP client already parses the host's redacted connection list.
Space access reuses it and submits an explicit per-space grant. Global/project
selections do not authorize a grant and are not changed by this flow.

### Why passkey calls and origin reads are explicit dependencies

Root operations default to the browser's WebAuthn function and current origin.
Tests supply those dependencies directly and exercise the real HTTP boundary
without replacing an ESM module. DOM tests install and restore their own
happy-dom globals. Each test file runs in its own `bun test` process.
