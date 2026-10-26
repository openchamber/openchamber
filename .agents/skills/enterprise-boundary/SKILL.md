---
name: enterprise-boundary
description: "Use when a change sends conversation content somewhere other than the session's OpenCode provider or this machine, opens a way into this machine (listening address, tunnel, relay, pairing, share link), adds a way to enter model providers, keys or endpoints, reports usage, or touches enterprise mode, the policy file or `enterprise-mode.js`."
---

# Enterprise Boundary

Enterprise mode is an administrator's promise: conversation content reaches only the model providers configured in OpenCode, and nothing opens this machine to others without the administrator's say. The user is not trusted to keep the promise; they may edit their environment, Settings, or install the npm server themselves. Every feature either keeps the promise by construction or answers to the mode.

The mechanism, its sources and the list of gated features live in the header of `packages/web/server/lib/enterprise-mode.js`; the admin-facing contract is the *Enterprise mode* section of `packages/docs/content/docs/security.mdx`. Read both before editing.

## Classify The Change

Name each way the change can cross the boundary. The classification is complete when every data flow and every listener the change adds or alters sits in one class below or is shown to stay inside.

| Class | What it is | Behavior outside enterprise mode | In enterprise mode |
|---|---|---|---|
| **Egress** | Conversation content (messages, turn excerpts, file contents, model output, session names, speech) leaves for any destination other than the session's OpenCode provider or this machine | Off until the user turns it on | Off, unless the administrator pins an in-house destination or the destination is this machine |
| **Metadata egress** | A message leaves without content (a push notification, a status ping) | As designed | Content stripped: generic text, no message text, no session name |
| **Exposure** | Another machine can reach this server or its data: a non-loopback listener, tunnel, relay, pairing candidate, share link | As designed, behind UI auth | Loopback only, unless the administrator allows network access; relay only on a pinned self-hosted endpoint; public tunnels off |
| **Provider entry** | The app adds a model provider, key, endpoint or custom provider | As designed | Refused; removing or switching existing accounts stays allowed. OpenCode's `provider.use` policy is the real lock |
| **Telemetry** | Usage or install identifiers are reported | As designed | The essential function stays (security update checks); usage and identifiers are dropped |

Inside the boundary, with no gate: work that reaches only the session's provider through OpenCode, work that stays on this machine, and the small model on the user's own provider (never another connected one). A user-initiated action toward a service the user connected themselves (GitHub, Linear) sits outside the mode today; when such an action carries conversation content, raise it with the maintainer.

Whether a flow belongs to a class, and whether an in-house pin should exist, are product decisions. When either is unclear, ask before building.

## Enforce At The Boundary

- **Server-side, at the point that performs the crossing.** Read `isEnterpriseMode()` or `readEnterprisePolicy()` at use time, in the route, job or runtime that sends or listens. UI hiding is courtesy; the refusal lives where the request is served. Answer refusals with 403 and `code: 'enterprise_mode'` where the neighbouring routes do.
- **Every entry point.** The web server serves web, desktop (in-process) and mobile; the CLI and `--host` reach the same `main()`; the Electron main process decides what to bind before the server starts; the VS Code extension host runs no OpenChamber server and bundles `enterprise-mode.js` for the parts it owns (`packages/vscode/src/DOCUMENTATION.md`). Write the surface list per `ui-api-decoupling` and give each runtime its enforcement or an explicit "does not exist here".
- **Fail closed.** An unreadable policy keeps the mode on, pins nothing and allows nothing. A pinned value that fails validation counts as unset.

## Admin Knobs

When teams plausibly need the feature on their own infrastructure (Jev on an in-house endpoint, a self-hosted relay, network access inside a closed network), a pin beats a plain off. A new knob gets:

1. A key in `policyFileSchema` and its environment variable, resolved in `readEnterprisePolicy` by the source rule: when the file turns the mode on, only the file decides and the environment adds nothing; otherwise the file value wins and the variable fills the gap.
2. Validation in the consumer, with an invalid value treated as unset.
3. Secrets kept on the server: `publicEnterprisePolicy` carries only what the UI must show.
4. The matching `enterprise-mode.d.ts` entry and cases in `enterprise-mode.test.js` for file, environment, both, and a broken file.

## Walk Every Surface

List every place a user meets the feature: Settings pages and their search entries (`lib/settings/metadata.ts`, `search.ts`), composer and pickers, menus, the command palette, notes that link to setup, onboarding. The walk is complete when each item has one of:

- **Disabled with the reason**, in words the user understands, in every locale (`locale-ui-patterns`), read from `useEnterpriseMode`, `useEnterprisePolicyStore` or `useJevBlockedByEnterprise`.
- **Hidden**, when the mode leaves nothing usable on a page (Routing without a pinned Jev, the tunnel page).
- **Unchanged**, with the reason it stays inside the boundary.

A link that leads to a setup the mode forbids is a defect. Report every surface to the maintainer, including the ones left unchanged.

## Record And Prove

- Add the feature to the gated list in the `enterprise-mode.js` header, and to *What changes* in `security.mdx` for every locale under `packages/docs/content/docs/`.
- Test the refusal with the mode on and the normal path with it off, at the enforcement point. Inject the policy through the `options` argument or set the variable inside the test; `packages/web/vitest.config.ts` clears the enterprise variables so a developer's shell cannot flip a suite.
- A live check where the crossing is a process boundary: start the server with the mode on and the crossing requested (for example `--lan`), and watch it refuse; then allow it and watch it work.

## Completion

Every crossing the change adds has a class, server-side enforcement on each runtime it exists on, a test with the mode on and off, a surface list with each surface's behavior, and updated docs. Open product questions are raised, never decided in the diff.
