# Browser performance capture

Start OpenChamber locally, then run:

```bash
bun run profile:browser
```

The command opens an isolated Chrome profile. On the first run, complete any
login or setup in that window, prepare the sessions and screen you want to
measure, then return to the terminal and press Enter. Use OpenChamber normally
for the next 60 seconds.

Chrome, Chromium, Comet, Dia, and Helium are auto-detected on macOS. Other
Chromium-based browsers can be selected with `--chrome /path/to/executable`.

The generated `artifacts/browser-profile-*/` directory contains:

- `summary.json`: long-task, memory, network, and OpenChamber operation counts;
- `trace.json`: import into Chrome DevTools Performance with **Load profile**;
- `network.har`: import into Chrome DevTools Network with **Import HAR**.

The HAR omits response bodies and redacts cookies, authorization headers, and
sensitive URL parameters. The trace applies the same key and URL-parameter
redaction, but profiling artifacts can still reveal project paths and endpoint
names. Do not publish them without review.

Useful options:

```bash
bun run profile:browser -- --duration 120
bun run profile:browser -- --url http://localhost:4173
bun run profile:browser -- --output /tmp/openchamber-profile
```

Run `bun run profile:browser -- --help` for all options.
