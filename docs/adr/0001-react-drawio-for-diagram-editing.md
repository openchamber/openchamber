# ADR 0001: Use `react-drawio` for diagram editing

The diagram integration needs an embeddable draw.io editor inside OpenChamber's React UI. The draw.io editor is distributed as a static iframe (`embed.diagrams.net`) that communicates via `postMessage`. Initial attempts to manage this protocol manually (listening for `onMessage`, sending XML via `dev.DrawIO.load/save`) failed due to timing, lifecycle, and cross-frame message routing issues.

We chose to use `react-drawio` (MIT, zero transitive dependencies, 76 KB unpacked) — a thin React wrapper that handles the iframe lifecycle and `postMessage` protocol. This is the same library used by `next-ai-draw-io` (the reference implementation), proving the integration works.

## Considered Options

- **Raw iframe** — Tried, failed. The `postMessage` protocol is undocumented beyond basic examples, and timing issues (iframe not ready, message queueing) were hard to debug.
- **Custom React wrapper** — Doable but isomorphic to `react-drawio`; would just be reinventing the same abstraction.
- **`react-drawio`** — Working, typed, zero-dependency, MIT. Matches our stack (React + TypeScript).

## Consequences

- The `react-drawio` package becomes a dependency of `packages/ui/`. If it becomes unmaintained, the wrapper is small enough to inline (~300 lines of source).
- All draw.io editor interactions (load XML, listen for saves, export images) go through the `DrawIoEmbed` component's props and ref API.
- Custom draw.io configuration (`urlParameters`, editor config) is passed via the component's standard props.
