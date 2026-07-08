// openchamber_relay_gate
//
// Feature gate for the private-relay UI — the surfaces for enabling the relay and
// pairing devices through it (Settings → Remote Instances "Relay" section and its
// settings-search entry). The relay transport itself is fully implemented and
// tested; this flag only hides the UI entry points until the feature is ready for
// public release (the connect flow is being unified across LAN / tunnels / relay).
//
// TO UNBLOCK FOR PUBLIC RELEASE: set RELAY_UI_ENABLED to true. Grep this token —
// `openchamber_relay_gate` — to find this file. Nothing else needs to change; the
// gated surfaces read this one constant. Also add a CHANGELOG entry then — the
// relay's changelog note is intentionally held back while this is off.
//
// Note: existing saved relay connections keep working regardless (this gates the
// UI for ADDING/pairing, not the runtime transport). If you also want to hide the
// mobile side of importing a relay link, gate the relay branch in
// packages/ui/src/apps/mobileQrScan.ts / mobileConnections.ts on this same flag.
// Typed as boolean (not the literal `false`) so gated call sites don't trip
// "condition always false" / unreachable-code checks — flipping to true is a
// one-word change with no other edits.
export const RELAY_UI_ENABLED: boolean = false;
