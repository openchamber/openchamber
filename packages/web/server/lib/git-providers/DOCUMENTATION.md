# Git Providers Configuration Module

## Purpose

- This module owns the per-provider git hosting configuration (`gitProviders` in the user settings file): API base URLs and provider-detection hostnames for GitHub, GitLab, and Gitea.
- It is the single source of truth for the effective provider defaults consumed by `packages/web/server/lib/{github,gitlab,gitea}` and is validated end-to-end through the settings GET/PUT routes (the `gitProviders` key round-trips via `sanitizeSettingsUpdate` in `packages/web/server/lib/opencode/settings-helpers.js`).
- Per-project API base URL overrides (`gitProviders` in `projects/<projectId>.json`) extend the global settings; a project override wins per provider over the global value.

## Entrypoints

- `packages/web/server/lib/git-providers/config.js`: global settings helpers, exporting the helpers directly.
- `packages/web/server/lib/git-providers/project-config.js`: per-project git provider API base URL overrides (`gitProviders` in `projects/<projectId>.json`), including directory→projectId resolution.
- `packages/web/server/lib/git-providers/routes.js`: `GET/PUT /api/projects/:projectId/git-providers` API routes (wired via `registerGitProviderRoutes` in `packages/web/server/lib/opencode/feature-routes-runtime.js`).

## Public exports — `config.js`

- `GIT_PROVIDER_DEFAULTS`: `{ github: 'https://api.github.com', gitlab: 'https://gitlab.com', gitea: 'https://codeberg.org' }`. Built-in defaults are **not persisted**; they are applied at read time by getters.
- `GIT_PROVIDER_DEFAULT_DETECT_URLS`: `{ github: ['github.com'], gitlab: ['gitlab.com'], gitea: ['codeberg.org'] }`. Built-in detection hostnames; remotes on these hosts classify as the provider with no configuration (mirrors the client-side built-ins in `packages/ui/src/lib/gitProvider.ts`).
- `normalizeBaseUrl(raw)`: normalize an API base URL (add `https://` when the scheme is missing, strip trailing slashes, preserve subpaths like `/gitlab`), `null` for empty/unparseable input.
- `normalizeDetectionHost(raw)`: extract the bare lowercase hostname from any git remote/URL form (`https://`, `ssh://`, scp-like `git@host:path`, IPv6); mirrors `packages/ui/src/lib/gitHost.ts` `parseGitHost`.
- `sanitizeGitProviders(payload)`: validate/normalize the `gitProviders` shape — only `github|gitlab|gitea` keys survive; `apiBaseUrl` via `normalizeBaseUrl`, `detectUrls` deduped bare hostnames; empty/absent values dropped; returns `undefined` when nothing valid remains.
- `readGitProvidersConfig()`: read the `gitProviders` section from `settings.json` (`OPENCHAMBER_DATA_DIR` env override, else `~/.config/openchamber`); never throws, returns `{}` on missing/invalid data.
- `getProviderApiBaseUrl(provider)`: configured value -> `GIT_PROVIDER_DEFAULTS[provider]` -> `null`.
- `getProviderDetectUrls(provider)`: effective detection hostnames — built-in default hosts plus configured `detectUrls`, deduped (the built-ins always apply).
- `githubWebOriginFromApiBase(apiBase)`: GitHub web origin from an API base — `https://api.github.com` -> `https://github.com`; Enterprise `https://host/api[/v3]` -> `https://host` (trailing `/api`/`/api/v3` stripped, subpath prefixes kept); otherwise the URL origin; never throws, falls back to `https://github.com`.

## Public exports — `project-config.js`

- `OPENCHAMBER_PROJECTS_DIR`: `path.join(OPENCHAMBER_DATA_DIR, 'projects')` (same `OPENCHAMBER_DATA_DIR` env logic as `config.js`).
- `sanitizeProjectGitProviders(payload)`: same provider allowlist/`normalizeBaseUrl` rules as `sanitizeGitProviders`, but the per-project shape only carries `apiBaseUrl` (`detectUrls` tolerated and stripped) plus an optional forced `provider` (`github|gitlab|gitea`, normalized lowercase; unknown values dropped); `undefined` when nothing valid remains.
- `readProjectJson(projectId)`: raw JSON object from `projects/<projectId>.json`; `{}` on missing/malformed file, `null` for an invalid projectId; never throws.
- `getProjectGitProviders(projectId)`: effective per-project overrides (`{}` when unset or invalid projectId).
- `resolveProjectIdFromDirectory(directory)`: projectId for a directory — worktree-aware: the directory is first resolved to its main repo root via `git rev-parse --git-common-dir` (handles linked worktrees created outside the project root, and a project rooted at the filesystem `/`), then the longest matching project path from the settings.json `projects` list that equals it or is a path-prefix wins; when git is unavailable or the directory is not a git repo, the directory's own exact/containment match applies; fallback `createProjectIdFromPath(directory)`; `null` for empty input. Results are cached per-directory for 60s (TTL cache, negative results included) so forge hot paths don't exec git / re-read settings.json per request. `_clearResolveProjectIdCache()` is a test-only hook to drop the cache.
- `getProjectProviderApiBaseUrl(provider, projectId)`: per-project `apiBaseUrl` override or `null`.
- `getProjectProvider(projectId)`: the project's forced provider (`github|gitlab|gitea`) or `null` when auto-detected.
- `getProjectProviderFromDirectory(directory)`: forced provider for a directory's owning project (via `resolveProjectIdFromDirectory` → `getProjectProvider`), or `null`.
- `getEffectiveProviderApiBaseUrl(provider, directory)`: project override -> `getProviderApiBaseUrl(provider)` (global -> built-in default); `null` only when nothing resolves.
- `saveProjectGitProviders(projectId, payload)`: persist the per-project overrides, preserving all other project JSON keys (atomic tmp-file + rename write); returns the saved `gitProviders` object (or `{}`); throws for an invalid projectId.

## Routes

- `GET /api/projects/:projectId/git-providers` → `{ gitProviders: { github?: { apiBaseUrl }, ... } }`.
- `PUT /api/projects/:projectId/git-providers` with body `{ gitProviders }` → `{ gitProviders }` (saved); `400` on missing projectId or invalid body shape.

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

## Per-project overrides

`projects/<projectId>.json` (under the same `OPENCHAMBER_DATA_DIR` root as `settings.json`):

```json
{
  "version": 1,
  "projectNotes": "...",
  "gitProviders": {
    "provider": "gitlab",
    "github": { "apiBaseUrl": "https://project.github.example.com" },
    "gitlab": { "apiBaseUrl": "https://project.gitlab.example.com" }
  }
}
```

- Per-project `gitProviders` carry `apiBaseUrl` only (no `detectUrls`); unknown provider keys are dropped and `apiBaseUrl` is normalized with the same rules as the global settings.
- Optional `provider` (`github|gitlab|gitea`) forces the project's git provider instead of auto-detection. Client-side, a forced provider short-circuits remote-host detection (`useGitProvider`); server-side, it makes any remote host acceptable for that provider's repo parsing (`gitlab/repo.js`, `gitea/repo.js`).
- `projects/<projectId>.json` is shared with the scheduled-tasks/projectNotes config; reading and saving preserve all other keys (the `gitProviders` key is omitted entirely when empty).
- **Precedence per provider:** project override (`projects/<projectId>.json` → `getProjectProviderApiBaseUrl`) > global `settings.json` (`getProviderApiBaseUrl`) > built-in default (`GIT_PROVIDER_DEFAULTS`).

## Consumers

- `packages/web/server/lib/github/octokit.js`, `device-flow.js`, `routes.js`, `repo/index.js`, `pr-status.js`, `repo/fork-detection.js`: GitHub Enterprise support (Octokit `baseUrl`, device-flow web origin, remote parsing, fallback URLs).
- `packages/web/server/lib/gitlab/auth.js`, `client.js`, `routes.js`: effective default base URL.
- `packages/web/server/lib/gitea/auth.js`, `routes.js`: connect-form default / status `defaultBaseUrl`.
- `packages/web/server/lib/opencode/settings-helpers.js`: `gitProviders` persistence whitelist.

## Notes for contributors

- Readers must never throw: `readGitProvidersConfig`, `readProjectJson`, and `githubWebOriginFromApiBase` fail closed.
- No new dependencies.