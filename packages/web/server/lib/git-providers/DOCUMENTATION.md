# Git Providers Configuration Module

## Purpose

- This module owns the per-provider git hosting configuration (`gitProviders` in the user settings file): API base URLs and provider-detection hostnames for GitHub, GitLab, and Gitea.
- It is the single source of truth for the effective provider defaults consumed by `packages/web/server/lib/{github,gitlab,gitea}` and is validated end-to-end through the settings GET/PUT routes (the `gitProviders` key round-trips via `sanitizeSettingsUpdate` in `packages/web/server/lib/opencode/settings-helpers.js`).

## Entrypoints

- `packages/web/server/lib/git-providers/config.js`: the single module file, exporting the helpers directly.

## Public exports

- `GIT_PROVIDER_DEFAULTS`: `{ github: 'https://api.github.com', gitlab: 'https://gitlab.com', gitea: null }`. Built-in defaults are **not persisted**; they are applied at read time by getters.
- `normalizeBaseUrl(raw)`: normalize an API base URL (add `https://` when the scheme is missing, strip trailing slashes, preserve subpaths like `/gitlab`), `null` for empty/unparseable input.
- `normalizeDetectionHost(raw)`: extract the bare lowercase hostname from any git remote/URL form (`https://`, `ssh://`, scp-like `git@host:path`, IPv6); mirrors `packages/ui/src/lib/gitHost.ts` `parseGitHost`.
- `sanitizeGitProviders(payload)`: validate/normalize the `gitProviders` shape — only `github|gitlab|gitea` keys survive; `apiBaseUrl` via `normalizeBaseUrl`, `detectUrls` deduped bare hostnames; empty/absent values dropped; returns `undefined` when nothing valid remains.
- `readGitProvidersConfig()`: read the `gitProviders` section from `settings.json` (`OPENCHAMBER_DATA_DIR` env override, else `~/.config/openchamber`); never throws, returns `{}` on missing/invalid data.
- `getProviderApiBaseUrl(provider)`: configured value -> `GIT_PROVIDER_DEFAULTS[provider]` -> `null` (gitea).
- `githubWebOriginFromApiBase(apiBase)`: GitHub web origin from an API base — `https://api.github.com` -> `https://github.com`; Enterprise `https://host/api[/v3]` -> `https://host` (trailing `/api`/`/api/v3` stripped, subpath prefixes kept); otherwise the URL origin; never throws, falls back to `https://github.com`.

## Settings shape

`~/.config/openchamber/settings.json`:

```json
"gitProviders": {
  "github": { "apiBaseUrl": "https://github.example.com/api/v3", "detectUrls": ["github.example.com"] },
  "gitlab":  { "apiBaseUrl": "https://gitlab.example.com", "detectUrls": [] },
  "gitea":   { "apiBaseUrl": "", "detectUrls": ["gitea.example.com"] }
}
```

- `apiBaseUrl`: API base URL; the per-account baseUrl (gitlab/gitea accounts) still wins when set; this is the default/fallback plus connect-form prefill.
- `detectUrls`: SSH/HTTPS URLs normalized to bare hostnames for provider autodetection (client-side; the server only persists/validates them).
- The whole `gitProviders` key is omitted when empty.

## Consumers

- `packages/web/server/lib/github/octokit.js`, `device-flow.js`, `routes.js`, `repo/index.js`, `pr-status.js`, `repo/fork-detection.js`: GitHub Enterprise support (Octokit `baseUrl`, device-flow web origin, remote parsing, fallback URLs).
- `packages/web/server/lib/gitlab/auth.js`, `client.js`, `routes.js`: effective default base URL.
- `packages/web/server/lib/gitea/auth.js`, `routes.js`: connect-form default / status `defaultBaseUrl`.
- `packages/web/server/lib/opencode/settings-helpers.js`: `gitProviders` persistence whitelist.

## Notes for contributors

- Readers must never throw: `readGitProvidersConfig` and `githubWebOriginFromApiBase` fail closed.
- No new dependencies.
