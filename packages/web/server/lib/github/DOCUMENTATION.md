# GitHub Module Documentation

## Purpose
This module provides GitHub authentication, OAuth device flow, Octokit client factory, and repository URL parsing utilities for the web server runtime.

## Entrypoints and structure
- `packages/web/server/lib/github/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/github/auth.js`: auth storage, multi-account support, and client ID/scope configuration.
- `packages/web/server/lib/github/device-flow.js`: OAuth device code flow implementation for browserless auth.
- `packages/web/server/lib/github/octokit.js`: Octokit client factory backed by current auth.
- `packages/web/server/lib/github/repo/index.js`: GitHub remote URL parser and directory-to-repo resolver.
- `packages/web/server/lib/github/pr-status.js`: Pull request status resolution across remotes for sidebar and PR UI flows.

## Public exports (from index.js)

### Auth (`auth.js`)
- `getGitHubAuth()`: Returns current auth entry (accessToken, user, scope, accountId).
- `getGitHubAuthAccounts()`: Returns list of all configured accounts.
- `setGitHubAuth({ accessToken, scope, tokenType, user, accountId })`: Stores or updates auth entry.
- `activateGitHubAuth(accountId)`: Sets specified account as current.
- `clearGitHubAuth()`: Removes current account or deletes storage file if last account.
- `getGitHubClientId()`: Resolves client ID from env var, settings.json, or default.
- `getGitHubScopes()`: Resolves scopes from env var, settings.json, or default.
- `GITHUB_AUTH_FILE`: Storage file path constant.

### Device flow (`device-flow.js`)
- `startDeviceFlow({ clientId, scope })`: Requests device code from GitHub.
- `exchangeDeviceCode({ clientId, deviceCode })`: Polls for access token.

### Octokit (`octokit.js`)
- `getOctokitOrNull()`: Returns configured Octokit instance or null if no auth.

### Repo (`repo/index.js`)
- `parseGitHubRemoteUrl(raw)`: Parses SSH/HTTPS URLs into `{ owner, repo, url }`.
- `resolveGitHubRepoFromDirectory(directory, remoteName)`: Resolves GitHub repo from git remote.

## Storage and configuration
- Auth storage: `~/.config/openchamber/github-auth.json` (atomic writes, mode 0o600).
- Client ID: `OPENCHAMBER_GITHUB_CLIENT_ID` env var → `settings.json` → default.
- Scopes: `OPENCHAMBER_GITHUB_SCOPES` env var → `settings.json` → default.

## Account resolution
Account IDs are resolved in priority order: explicit `accountId` → user login → user ID → token prefix.

## Notes for contributors
- All auth operations use atomic file writes for safe multi-instance sharing.
- Device flow handles GitHub's `authorization_pending` responses at caller level.
- Repo parser supports `git@github.com:`, `ssh://git@github.com/`, and `https://github.com/` URL formats.
