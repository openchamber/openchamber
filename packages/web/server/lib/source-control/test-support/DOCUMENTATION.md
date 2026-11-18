# Source-control test support

## Ownership

The synthetic service in `service-login.ts` stands in for a CLI with its
own login state. The host contract test bundles it as `main.js` for Node.

## Invariants

The test writes `login-state.json` beside the bundle. It contains no
credentials, and the service never contacts a forge. The SDK request reader
checks the wire envelope but leaves mutation context fields as JSON. The
fixture preserves the original field reads: missing fields stay undefined,
and reading a field from a missing or null parent still fails.
