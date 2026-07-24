# Browser performance capture

Start OpenChamber locally, then run:

```bash
bun run profile:browser
```

The command opens an isolated Chrome profile. On the first run, complete any
login or setup in that window, prepare the sessions and screen you want to
measure, then return to the terminal and press Enter. Use OpenChamber normally
for the next 60 seconds.

Google Chrome is selected first on macOS, with Chrome Canary and Chromium as
fallbacks. Other Chromium-based browsers are used only when explicitly selected
with `--chrome /path/to/executable`.

The generated `artifacts/browser-profile-*/` directory contains:

- `summary.json`: long-task, memory, network, sync-operation, and UI streaming/render metrics. `failedRequests` includes transport failures and HTTP 4xx/5xx responses, while `httpErrorResponses` isolates HTTP errors;
- `trace.json`: import into Chrome DevTools Performance with **Load profile**;
- `network.har`: import into Chrome DevTools Network with **Import HAR**.

`summary.json.longTaskAttribution` correlates long tasks with global-session
lifecycle publications, session navigation, and targeted sidebar/message-list
renders. One task may appear under multiple marks when phases overlap.

Chrome trace finalization is allowed up to two minutes for large captures. If
Chrome still does not emit its completion event, the command preserves the
summary, HAR, and all trace events received so far instead of discarding the
entire recording. In that case `summary.json` sets `traceComplete` to `false`,
and trace-derived long-task totals should be treated as lower bounds.

Trace events are streamed to disk instead of being serialized into one large
JavaScript string. Summary and HAR files are written first, so they remain
available even if the trace file cannot be completed. `traceFileComplete`
reports whether `trace.json` finished writing.

The HAR omits response bodies and redacts cookies, authorization headers, and
sensitive URL parameters. The trace applies the same key and URL-parameter
redaction, but profiling artifacts can still reveal project paths and endpoint
names. Do not publish them without review.

The capture bypasses the PWA service worker and reloads without the browser cache before recording, so repeated optimization runs execute the current local build instead of a previously cached bundle. Network recording begins after that reload, so startup asset downloads are not included in the HAR totals.

Useful options:

```bash
bun run profile:browser -- --duration 120
bun run profile:browser -- --url http://localhost:4173
bun run profile:browser -- --output /tmp/openchamber-profile
```

Run `bun run profile:browser -- --help` for all options.
