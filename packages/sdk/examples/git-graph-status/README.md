# Git Graph Work Status example

This status-only extension draws recent commits through its local, read-only Git service. It has no rail panel.

The manifest opts into a collapsed Work Status section and requires the actual Work Status project directory. A saved expansion choice still wins. When the section is expanded, a supporting host moves the commit-range select and Refresh button into the section header. The page keeps its own controls visible until that registration succeeds, so older hosts still have working controls. Manual branch selection remains in the section body.

The example registers `onStatusControl` immediately after `connectHost`. It publishes one select with Auto, All, and Manual, plus Refresh. It republishes when the control values or project context change. Folding or hiding the section removes the frame and its header controls.

Display preferences use device storage only when `features.deviceStorage` is advertised in the ready context. They stay in this browser profile, partitioned by runtime and extension installation, rather than being stored on the server. On older hosts the example keeps its existing instance-storage behavior. That is an example fallback, not an SDK fallback. If a preference read fails or returns malformed data, the page keeps its current selection and reports the problem instead of treating it as empty preferences.

The graph uses the optional syntax keyword, string, number, function, and type colors when supplied by the host. It falls back to the existing semantic graph colors on older snapshots.

When a host advertises popovers, hovering or focusing a commit row opens a separate, theme-aware detail frame. The frame fetches that commit once from the existing local service and shows its author, time, subject, refs, stats, hash, Open diff action, and GitHub action when the configured remote is on GitHub. Row clicks still expand the inline detail card, and hosts without popovers keep that behavior unchanged.

Build `status/main.js` and `service/main.js` before installing the folder. The checked-in bundles are maintained by the SDK example rebuild process.
