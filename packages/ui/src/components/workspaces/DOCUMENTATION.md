# Secure Workspaces UI

`WorkspaceLifecycleView` owns the daily project-scoped Secure Workspaces product surface. It is mounted by the web/Electron main-tab layout and by the hosted/Capacitor mobile surface. VS Code intentionally does not expose it.

`SecureWorkspacesSettings` owns only host policy and activation: enablement, providers, images, resources, egress, Kubernetes policy, retention, and credential grants.

Workspace creation does not require an explicit image in the UI. An empty persisted image delegates to the server-owned signed release digest; browser payloads never select or override the provider image.

The lifecycle surface uses the current runtime and explicit project context as its cache identity. An open new-session draft's selected directory/project takes precedence, followed by a selected session directory that belongs to a known host project, then the active sidebar project. An invalid explicit draft target fails closed, and a workspace runtime directory such as `/workspace` is never substituted for host project context. A runtime or project-context change clears workspace selection, diagnostics, and export review state before loading the new scope. List or status failure retains prior authoritative data within the same scope and presents the failure separately. The desktop header shield toggles between this surface and chat.

Read/use actions remain available to capability-scoped remote clients. Once a structured server denial identifies missing `workspace.admin` or `host.apply`, the surface disables only the affected privileged actions and shows a host-grant-required state instead of reopening unusable reauthentication dialogs. Runtime authorization remains authoritative.

Cleanup, detach, apply, and export discard retain explicit confirmation. Export review supports whole-file, text-hunk, and binary whole-file selection through the existing runtime API contract.

All privileged prompts go through the shared `useWorkspaceReauth` hook (`WorkspaceReauth.tsx`), used by this surface, `SecureWorkspacesSettings`, and the new-session flow. It tries a still-valid server step-up window first, then a passkey, and opens the password dialog only as the last step; a missing independent UI password surfaces the localized `setupRequired` guidance instead of a dead password prompt. Per-surface reauth dialogs must not be reintroduced.

Status payloads merge into the last known per-workspace status (`workspaceStatusSnapshot`); a workspace absent from one payload keeps its previous badge instead of flipping to "Unknown status". A policy-fingerprint mismatch is rendered as a localized "policy outdated" banner with delete-and-recreate guidance rather than the raw server sentence; deletion of such workspaces remains functional. The selected-workspace panel separates the primary start action and destructive delete from advanced handoff/repair actions, and shows a reconnect hint with Repair while not connected. When no explicit project context exists, the surface lists host projects for an explicit choice. Desktop passes `onClose` for an explicit exit back to chat.

## Ordinary New Session Contract

The normal entrypoint is the existing desktop/mobile new-session flow. Host remains the default; the user explicitly chooses a project and Secure Workspace mode. The UI sends one runtime-owned idempotent operation ID to the server and never selects provider resources or images. The server reuses an applicable connected workspace or requires `workspace.admin` plus request-bound reauthentication before creating one, waits boundedly for `connected`, creates and verifies the routed session, and returns its authoritative workspace binding. Retries preserve the operation ID so timeout or post-create verification failure cannot create duplicates. The prompt is sent only after successful session verification.

The shield is the secondary management/recovery surface. It can be opened without a selected session, but only with an explicit project context; otherwise it must ask for a project instead of using a hidden last directory. Workspace bootstrap runs list discovery, starts sync through the generated SDK, and performs a bounded status wait. Successful session creation publishes the runtime directory and workspace identity, selects the session, switches to chat, and must make the session visible in the matching sidebar scope immediately.

The authoritative certification status and remaining compatibility gates are maintained in `docs/SECURE_WORKSPACES_SPECIFICATION.md`.
