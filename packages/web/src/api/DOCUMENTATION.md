# Web API adapters

## Ownership

`packages/web/src/api` is the browser runtime's wire layer between `@openchamber/ui` and an OpenChamber server. It owns the HTTP routes, the zod parsers that turn server answers into the UI's neutral API types, and the compatibility adapters for older servers. It does not own UI state or domain presentation.

Every provider read and mutation goes through `/api/source-control/<provider>/...` (`source-control-providers.ts`), and every tracker call through `/api/tracker/<provider>/...`, except the legacy fallbacks described below. `packages/ui` never names a provider or a wire shape.

Reference-picker reads cover searched lists, an item's detail, and listed change-request statuses. Discussions are read where `features.discussions` says the provider keeps them, and each read exists only where the provider's descriptor offers it (`features.referenceSearch`, `referenceDetail`, `listStatuses`, `referencesAcross`).

## Invariants

- A failed or unreadable answer is an error, never an empty success. A list may drop one malformed entry, but a response that lists providers or trackers and yields none readable is an error.
- A value a newer server may send reads as its closest known meaning (an unknown state category or priority as none) rather than failing the read.
- Partial multi-project results survive: projects a list could not read are named in `incompleteProjectIds`, and items already read stay where the caller keeps them.
- A malformed optional field is dropped without failing the containing read: absent stays absent rather than empty. This covers comment edit permissions, suggestion excerpts, and stacks.
- Compatibility fields stay absent when an older server or host does not send them: an auth account's `usable` leaves the picker on the current-only rule, an extension tracker's `connect` card is absent for built-ins and older servers, and a missing suggestion excerpt costs only the suggestion's base.
- Stack layers are bottom first. A stack that does not hold together is treated as unknown, never as a failed read of the surrounding change request.
- A binding revision of 0 means the unbound repository, read with the account the client is signed in to.
- A request for a path inside an isolated space names that space's root when the open folder is elsewhere, so a draft waiting for a space sees that space's files rather than the project's.
- A review carries exactly one of a verdict or votes, never both and never a guess between them.
- Commits, verdicts, and reviewers are read only when the timeline is requested. Optional review-host fields (vote labels, submit requirements, revisions) stay absent for every other host.
- Every item returned by a reference picker or batched summary is stamped with the provider it was read from, and batched summaries name the account they were read with. The reference picker reads through the provider's own source-control routes so its lists and previews carry the repository's bound read context.
- An issue outside the bound repository network is `null`, not an error.

## Decisions

### Why the settings surface is a query parameter and not a header

The server resolves per-surface profile fields from the surface kind. A query parameter needs no CORS preflight; the packaged desktop shell and the phone app are cross-origin, and an older instance refuses an unknown header.

### Why the provider registry keeps built-in descriptors in the web adapter

A server older than `GET /api/source-control/providers` answers 404 but serves exactly GitHub and GitLab. The adapter answers with their descriptors so `packages/ui` never names a provider. Keep them identical to the server's built-in descriptors, including the change-review features that are published only where declared: the UI schema reads their absence.

### Why an unknown provider instance is normalized as an origin

The instance registry is seeded with the built-in providers and replaced by whatever `providers()` last reads. A provider no descriptor has named yet is normalized as an origin, the form every self-hosted forge uses. In the same way, an empty project owner passes for a provider whose descriptor has not been read because it may be path-style; the server, which knows the provider, validates it.

### Why the tracker adapter probes the wire before every read

A server older than `GET /api/tracker/providers` answers 404, or passes the unknown path to whatever sits behind it, which may answer 2xx with a non-JSON page (a SPA fallback or OpenCode 1.x's app proxy). A new server answers this route with JSON, so a non-JSON answer means the route is not there; a JSON answer that does not parse still fails. Such a server serves exactly Linear through `/api/linear/*` in Linear's own shapes. The adapter answers with Linear's built-in descriptor and maps those shapes to the neutral tracker shapes, so `packages/ui` never sees the difference.

The wire answer is cached per runtime key because the adapter outlives a runtime switch; another runtime asks its own server. A failed read is not remembered, so the next call asks again.

### Why file search uses OpenCode's `file.find` and not `/api/find/file`

`file.find` answers file search on OpenCode 2.x; `/api/find/file` has no route there and falls through the generic proxy to a 404.

### Why a notification suppresses the foreground copy when background push is active

Background push is the delivery channel when the web/PWA client is not focused. The main notification toggle and templates stay enabled, but a hidden page with an active push subscription does not also show the same foreground notification. Installed PWAs differ here: some expose `Notification.permission` yet only allow notifications through an active service worker registration.

### Why the legacy Linear adapter mirrors the server's descriptor

A legacy server serves exactly Linear, in Linear's own shapes. The adapter maps them the same way the server's tracker adapter does (`server/lib/linear/tracker.js`), and `BUILT_IN_LINEAR_TRACKER` must stay identical to that module's descriptor. Servers from before multiple workspaces name only the organization, so that single organization becomes the one account. Such a server serves no extension tracker, so the extension-only connect and OAuth-client routes report `UNSUPPORTED`.

### Why the wire defaults hosts to github.com

The reference wire reads `owner/repo#number`, optionally `@host`. A missing host, or `github.com`, is the default, so it is left off. A ref on any other host names it. In the detail request the same rule applies: a missing host means `github.com`, so only another host is sent.
