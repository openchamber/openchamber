# Secure Workspaces UI

`WorkspaceLifecycleView` owns the daily project-scoped Secure Workspaces product surface. It is mounted by the web/Electron main-tab layout and by the hosted/Capacitor mobile surface. VS Code intentionally does not expose it.

`SecureWorkspacesSettings` owns only host policy and activation: enablement, providers, images, resources, egress, Kubernetes policy, retention, and credential grants.

The lifecycle surface uses the current runtime and directory as its cache identity. A runtime or project/directory change clears workspace selection, diagnostics, and export review state before loading the new scope. List or status failure retains prior authoritative data within the same scope and presents the failure separately.

Read/use actions remain available to capability-scoped remote clients. Once a structured server denial identifies missing `workspace.admin` or `host.apply`, the surface disables only the affected privileged actions and shows a host-grant-required state instead of reopening unusable reauthentication dialogs. Runtime authorization remains authoritative.

Cleanup, detach, apply, and export discard retain explicit confirmation. Export review supports whole-file, text-hunk, and binary whole-file selection through the existing runtime API contract.
