# Tracked item interest

## Ownership

This module owns the client interest set and normalized item identities shared with the server's tracked-items module. The server owns following remote state and publishing updates.

## Invariants

- Mounted surfaces declare one replaceable interest set each. The debounced union sends only on change and after reconnect, including an emptied union; visibility accompanies interest so a lost presence update repairs on the next send.
- Visible interests fill the server cap before background followers, with earlier declarations retaining priority across updates. Capping locally prevents an oversized union from disabling every surface's updates.
- A reconnect resends because connection IDs have server-local lifetimes. Incoming records remain assigned to the runtime that sent them; a branch's open change request also updates its thread entry.
- Keys match the server and include provider instance and case-sensitive account identity, preventing collisions across hosts. Legacy GitHub records without an instance mean github.com, and legacy kindless tracker records mean Linear.
- Invalid records drop independently, and state must match item kind and key. Unknown state remains distinct from a settled remote result; newer canonical tracker categories replace legacy raw state fields at the parsing boundary.
