---
name: ui-api-decoupling
description: Use when creating or modifying OpenChamber shared UI data access, OpenCode SDK calls, `RuntimeAPIs`, runtime fetch/auth/URLs, authenticated browser assets, bridges/proxies, runtime switching, or server API routes.
---

# UI API Decoupling

## Core Boundary

- Official OpenCode API calls use `@opencode/client` (OpenCode 2.x, `/api/*` routes) through `opencodeClient`; only `packages/ui/src/lib/opencode/` sees wire types, everything else uses the domain model in `lib/opencode/model.ts`.
- OpenChamber-owned HTTP capabilities use `RuntimeAPIs` where runtime-specific behavior exists, otherwise explicit OpenChamber routes through `runtimeFetch`.
- Browser/realtime consumers use shared runtime URL/socket helpers.
- Shared UI never hardcodes localhost, ports, API origins, credentials, or one runtime's transport assumptions.
- Treat runtime adapters as the imperative shell: they own transport, auth, serialization, and platform mechanics. Shared feature code receives trusted contracts and owns domain decisions.

## Classify First

| Need | Correct path |
|---|---|
| Official OpenCode endpoint | `opencodeClient` or its SDK client |
| SDK gap for official OpenCode | Narrow documented wrapper in `opencodeClient` preserving request fidelity |
| OpenChamber HTTP route | `runtimeFetch('/api/...')` |
| Runtime-owned capability | Extend `RuntimeAPIs` and implement each applicable runtime |
| Browser-owned authenticated URL | Runtime URL resolver and scoped URL auth |
| SSE/WebSocket | Owning realtime transport; also load `relay-transport` |

## Name The Surfaces Before Editing

Before writing code that changes what a user can reach or do, write the surface list: every runtime this behavior exists on, and one line per runtime saying what happens there. Runtimes are web, Electron desktop, VS Code, hosted mobile, and Capacitor mobile.

The step is done when no runtime is missing a line. "Not applicable" is a line; silence is not. A stable unsupported response is a valid outcome, an accidental fallthrough is not.

Carry the list into the pull request *Affected surfaces* table. A runtime you cannot answer for goes in the list as unknown.

This applies to any user-reachable behavior, not only shared UI data access. A sequence that spans native shell, server, and renderer has surfaces too; so does a capability that only one runtime implements today.

## Load References By Task

| Task | Required reference |
|---|---|
| Iframes, downloads, raw images, object URLs, URL tokens | `references/browser-assets-and-auth.md` |
| Adding runtime capabilities, VS Code behavior, Electron privilege/security, unsupported runtime behavior | `references/runtime-parity.md` |
| Locating implementations, route registration, runtime switching, or focused tests | `references/implementation-map.md` |

Load every matching reference before editing.

## Rules

1. **Call official OpenCode APIs through the SDK**, preserving its method, body, headers, query, auth, and abort signal.
2. **Keep OpenChamber routes explicit.** Register them before the generic OpenCode proxy.
3. **Use runtime APIs for runtime-owned capabilities.** Components consume hooks/providers, not runtime globals.
4. **Resolve runtime state at call time.** Do not cache runtime base URLs, resolver output, credentials, or SDK clients across endpoint switches.
5. **Let transport own auth.** HTTP uses runtime bearer handling; browser/realtime URLs use scoped short-lived URL auth where headers are impossible.
6. **Never put long-lived client credentials in URLs.** Do not manually append URL tokens.
7. **Authoritative fetches signal failure.** Adapters return a distinct failure result (`sync-state-invariants`, *Failure Is Not Empty*).
8. **Keep privileges at the native/runtime boundary.** UI visibility and prompts are not authorization.
9. **Parse at the boundary.** Treat external, persisted, bridge, IPC, and network payloads as unknown until a schema, parser, or narrow constructor produces the trusted type consumed by shared code. Do not validate fields and then continue passing the raw payload.
10. **Model the real contract.** Prefer precise result/state unions and required dependencies over loose strings, boolean combinations, optional callback bags, `any`, or repeated casts. Make unsupported runtime behavior and failure distinct from valid empty success.
11. **Keep adapters deep and bridges thin.** Hide meaningful protocol or platform mechanics behind an intention-revealing runtime operation; do not add pass-through layers that only rename SDK, fetch, or bridge calls.
12. **Scope every OpenCode read to the directory being worked in.** Each such read starts that location with all its MCP servers, so one read per known project is a fan-out (`opencode-v2`, *Every directory-scoped read starts a location*).

## HTTP Decision Rules

Pass route paths directly to `runtimeFetch`:

```ts
await runtimeFetch('/health');
await runtimeFetch('/api/config/settings');
await runtimeFetch('/api/fs/raw', { query: { path } });
```

Do not immediately fetch a URL produced by `getRuntimeUrlResolver()`. Use the resolver only when the browser/realtime API itself consumes the URL:

```ts
const imageSrc = getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw?path=diagram.png');
const eventUrl = getRuntimeUrlResolver().sse('/api/event');
```

Plain `fetch` is reserved for intentional external origins that are not the active OpenChamber/OpenCode runtime.

## Runtime Switch Safety

Review runtime base URL, auth, SDK clients, terminal/realtime transports, stores, session memory, and caches. Key caches by runtime identity where IDs, paths, or URLs can collide. Reset or reconnect affected state through the established runtime-switch flow.

Re-parse values obtained after a switch at their owning boundary. A type established for one runtime response does not make cached raw data from another runtime trustworthy.

## Verification

- Official calls use SDK paths or documented SDK-gap wrappers.
- OpenChamber routes win before generic proxy fallback.
- Request fidelity, auth, abort, query, and body behavior are tested.
- Browser/realtime auth uses narrow allowlists and scoped tokens.
- Every applicable runtime has implementation or explicit unsupported behavior, and the surface list written before editing has a line for each.
- Runtime switching cannot reuse stale endpoint/auth/cache state.
- Privileged Electron/extension behavior is enforced outside the renderer.
- Focused transport, bridge, proxy, auth, and runtime tests pass.
