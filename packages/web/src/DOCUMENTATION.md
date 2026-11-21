# Web app entrypoints

## Ownership

`packages/web/src` owns the browser entrypoints (`main.tsx`, `mini-chat-main.tsx`, `mobile-main.tsx`), the runtime bootstrap in `runtimeConfig.ts`, and the push service worker `sw.ts`. The React app, stores, and views live in `@openchamber/ui`; this module only configures the runtime and hands it over.

## Invariants

- The app render waits for a desktop relay-host restore to pick its transport, so the user sees the splash instead of a transient auth screen against an endpoint still being selected. Outside desktop, or with no relay host, the restore promise is resolved immediately. A stuck probe or tunnel gives up after ten seconds so it never holds the app hostage.
- The desktop shell is told which instance this window shows at boot and on every runtime switch. A window opened for a saved host, or switched in place, carries no host tag of its own; without the report the shell's window-reuse lookup opens another window instead of reusing this one. The bridge is absent off desktop, so the report is a no-op there.
- The service worker keeps the Workbox injection point (`self.__WB_MANIFEST`) so `vite-plugin-pwa` can build.
- A module that fails to load is tried again and then reloads the page once. A dropped connection during dev compilation or a chunk replaced by an update otherwise leaves an empty page for good.
- Pushes clear handled notifications by `tag@nid`: the entry names the newest push it covers, and a notification from a newer push with the same tag stays because pushes can arrive out of order. A notification without a `nid` is older and is closed.
- A push must show a notification; browsers revoke or warn on silent ones, so a cleared cause rides on the next push instead of a push of its own.
- A tagged push requests `renotify` so replacing a session's earlier notification alerts again. Untagged pushes omit it because browsers require a nonempty tag when `renotify` is true.
- Only the mounted app may accept notification navigation. An older page may not understand the message, so navigation is skipped only after the app explicitly accepts it; focus first to wake suspended pages.

## Decisions

### Why the service worker is minimal and uses no Workbox runtime helpers

The Workbox injection point must stay so `vite-plugin-pwa` can build, but the worker intentionally uses no Workbox runtime helpers: iOS Safari can be fragile with more complex service-worker bundles, and push notifications need only a minimal worker.

### Why the runtime is configured before the SDK is used

`createWebAPIs` imports UI stores, which instantiate the OpenCode SDK singleton before the endpoint is configured, so the bootstrap reconnects the SDK to the runtime base URL immediately after setting it. Relay-capable windows may also select a reachable direct leg before React subscribes to runtime-change events, so the SDK is bound explicitly again after the restore.

### Why a relay-host window forces the restore past the already-active check

Boot has already set the runtime key when the window is opened for this relay host. Without forcing the restore past that check the tunnel never opens. A window opened for a specific direct instance keeps the injected endpoint; the main window and menu New Window restore the default host on relaunch.

### Why host reachability is warmed after bootstrap rather than during it

The switcher should open on real values instead of probing for the first time under the user's cursor. The warmup is unprompted work and the network is busiest at launch, so it starts three seconds after the endpoint is settled and past the app's own bootstrap.

### Why the mobile shell reloads across the phone threshold

The viewport watcher reloads into the other app shell when the viewport crosses the phone threshold after boot. It is a no-op in fixed shells and with `?surface=` overrides.
