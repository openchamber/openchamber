# Plugins Module Documentation

## Purpose
This module loads user-owned OpenChamber extension files from the local config directory.

OpenChamber plugins are separate from OpenCode plugins. OpenCode plugins extend OpenCode request/provider behavior, while OpenChamber plugins extend OpenChamber UI/server features. The first supported OpenChamber plugin interface is for quota providers.

## Quota provider plugins
Quota plugins live outside the package directory so they survive package updates:

```text
~/.config/openchamber/plugins/quota/<provider>.js
~/.config/openchamber/plugins/quota/<provider>.mjs
```

Each plugin file should export a default function. The loader calls the function with a context object and expects a provider implementation object in return.

```js
export default ({
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  formatMoney,
  readAuthFile,
  getAuthEntry,
  normalizeAuthEntry,
}) => ({
  providerId: 'my-provider',
  providerName: 'My Provider',
  isConfigured: () => {
    const auth = readAuthFile();
    const entry = normalizeAuthEntry(getAuthEntry(auth, ['my-provider']));
    return Boolean(entry?.key || entry?.token);
  },
  fetchQuota: async () => {
    return buildResult({
      providerId: 'my-provider',
      providerName: 'My Provider',
      configured: true,
      usage: {
        windows: {
          daily: toUsageWindow({ usedPercent: 25, remainingPercent: 75 }),
        },
      },
    });
  },
});
```

## Loader context
The quota plugin context currently includes:

- `buildResult`
- `toUsageWindow`
- `toNumber`
- `toTimestamp`
- `formatMoney`
- `readAuthFile`
- `getAuthEntry`
- `normalizeAuthEntry`

These helpers mirror the built-in quota provider helpers so plugin providers can produce the same API shape without importing internal files directly.

## Provider ID collisions
If a quota plugin returns a `providerId` that matches a built-in quota provider, the plugin overrides the built-in provider in the local registry. This allows local customization, but it is intentionally silent at runtime, so plugin authors should choose stable, unique provider IDs unless they explicitly want to replace a built-in provider.

## Trust boundary
Plugin files are regular JavaScript modules loaded by the local OpenChamber server. Users should only install plugin files they trust. This is intended for local user customization, not for loading untrusted remote code.

## Runtime scope
The plugin loader runs in the web, desktop (Electron), and VS Code extension runtimes. The web and desktop runtimes use the full server-side loader at `packages/web/server/lib/plugins/loader.js`, which executes plugin modules and returns their provider implementations directly. The VS Code extension host cannot run the full loader (different runtime, no express context) but its quota list in `packages/vscode/src/quotaProviders.ts` now scans the same plugin directory via regex on each file's `providerId` / `aliases` literals; a plugin is reported as "configured" if any of its alias keys has an entry in `~/.local/share/opencode/auth.json`. Plugin `fetchQuota` calls still run through the webview bridge, which sees the same auth.json and the same plugin directory.
