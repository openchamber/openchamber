# Skills Catalog Module Documentation

## Purpose
This module provides skill discovery, scanning, and installation capabilities for OpenCode. It supports skill sources backed by git repositories, with caching and conflict resolution for skill installation.

## Entrypoints and structure
- `packages/web/server/lib/skills-catalog/`: Skills catalog module directory containing all skill-related functionality.
  - `cache.js`: In-memory cache for scan results with TTL support.
  - `curated-sources.js`: Predefined skill sources (Anthropic, OpenAI, Cursor, Matt Pocock).
  - `github-meta.js`: Best-effort GitHub repository metadata (stars, last push) with in-memory TTL cache.
  - `git.js`: Git operations helpers for cloning and auth error detection.
  - `install.js`: Skills installation from git repositories.
  - `installed-sources.js`: Which source and repo subpath each catalog-installed skill came from, for the Installed badge.
  - `remove-directory.js`: Deletes a clone or skill folder, retrying a delete Windows refuses for a moment.
  - `scan.js`: Skills scanning from git repositories.
  - `source.js`: Source string parsing for git repositories.

## Public API

The following functions are exported and used by the web server:

### Cache (`cache.js`)
- `getCacheKey({ normalizedRepo, subpath, identityId })`: Generate cache key for scan results.
- `getCachedScan(key)`: Retrieve cached scan result if not expired.
- `setCachedScan(key, value, ttlMs)`: Store scan result with TTL (default 3 hours).
- `scanWithCache(key, loader, { refresh })`: Run a scan loader with cache lookup, in-flight deduplication, and a global concurrency limit (2 concurrent scans); only `ok: true` results are cached.
- `clearCache()`: Clear all cached scan results.
- Scan results persist to `skills-catalog-cache.json` in the OpenChamber data dir (debounced, atomic rename) and survive server restarts within the TTL.

### Curated Sources (`curated-sources.js`)
- `getCuratedSkillsSources()`: Return list of curated skill sources (Anthropic, OpenAI, Cursor, Matt Pocock).
- `CURATED_SKILLS_SOURCES`: Constant array of predefined sources.
- `excludedSkills` (optional, per source): skill directory names the catalog never lists for that source. Used for skills whose license forbids redistribution (Anthropic's `docx`, `pdf`, `pptx`, `xlsx`). Server-only; stripped from the sources sent to the UI.

### GitHub Repository Metadata (`github-meta.js`)
- `fetchGitHubRepoMetas(normalizedRepos)`: Fetch `{ stars, repoUpdatedAt }` for GitHub `owner/repo` strings. Best-effort: failures resolve to `null`; in-flight requests deduplicate; results cached in memory and on disk (`skills-github-meta.json`) for three hours.
- `clearGitHubMetaCache()`: Test-only cache reset.

### Source Parsing (`source.js`)
- `parseSkillRepoSource(source, { subpath })`: Parse git repository source string into structured object with SSH/HTTPS clone URLs, normalized repo, and effective subpath. Supports SSH URLs, HTTPS URLs, and shorthand `owner/repo[/subpath]` format.

### Git Repository Scanning (`scan.js`)
- `scanSkillsRepository({ source, subpath, defaultSubpath, identity, credentialResolver })`: Scan a Git repository for skills by cloning it and reading its `SKILL.md` files. Account identities use their connected HTTPS credential, SSH identities use their managed key, anonymous identities use credential-free HTTPS, and no identity (labelled "This machine" in the catalog dialog) uses the server's own Git configuration and credential helpers.

### Git Repository Installation (`install.js`)
- `installSkillsFromRepository({ source, subpath, defaultSubpath, identity, credentialResolver, scope, targetSource, workingDirectory, userSkillDir, selections, conflictPolicy, conflictDecisions })`: Install selected skills from a Git repository. It uses the same identity transports as scanning and supports user/project scopes, opencode/agents targets, conflict resolution (prompt/skipAll/overwriteAll), and sparse checkout.

### Install provenance (`installed-sources.js`)
The catalog's Installed badge used to match by name alone, so every same-named entry from every source read as installed (#4756). An install that names its catalog `sourceId` now records `{ skillName, skillDir, sourceId, scope, source, sourceRef }` in `skills-installed-sources.json` in the OpenChamber data dir (`version: 1`, mode 0600, atomic rename through a per-write temporary name).
- `appendInstalledSources(entries)`: record installs, deduped on source, subpath and scope. Best-effort: a failed write logs and leaves the install successful.
- `readInstalledSources()`: entries keyed by skill name. A missing or malformed file means "no records", never an error.
- `removeInstalledSources(skillName)`: forget a deleted skill's records, called after a skill delete.
- `isInstalledFromSource(byName, skillName, sourceId, skillDir)`: the badge rule. A name with records reads as installed only for a recorded source and subpath; a name without records (installed before the registry existed, or by hand) keeps the plain name match.
Web (`../opencode/skill-routes.js`) and VS Code (`packages/vscode/src/skillsCatalog.ts`, `bridge-config-runtime.ts`) share this module and file.

## Internal Helpers

The following functions are internal helpers used by exported functions:

### Git Helpers (`git.js`)
- `runGit(args, options)`: Execute a Git command with optional managed identity, credential resolver, timeout, and max buffer. HTTPS tokens go through the one-use local credential broker and never enter Git's arguments. Returns `{ ok, stdout, stderr, message, code, signal }`.
- `looksLikeAuthError(message)`: Detect if error message indicates authentication failure (permission denied, publickey, etc.).
- `assertGitAvailable()`: Check if git is available in PATH.

### Skill Name Validation (used in `install.js`, `scan.js`)
- `validateSkillName(skillName)`: Validate skill name against pattern `/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/` (1-64 chars, lowercase alphanumeric with hyphens).

### File System Helpers (`install.js`, `scan.js`, `remove-directory.js`)
- `removeDirectory(dir, { warn })` (`remove-directory.js`): Remove a directory recursively, trying again after 250, 500, 1000 and 2000 ms. A delete that still fails logs a warning naming the folder and leaves it; the scan or install still succeeds. `packages/vscode/src/skillsCatalog.ts` uses the same helper and passes a `warn` that writes to the "OpenChamber" Output channel, because the extension host's console is not kept in any log.
- `removeStaleCatalogFolders()` (`remove-directory.js`): Remove `openchamber-(vscode-)?skills-(scan|install)-*` folders the current user owns and that are older than an hour from the temp directory. Every scan and install, in both runtimes, starts it right before creating its own clone and does not wait for it. One sweep runs at a time per process. A folder it cannot delete stays without a log line; a failed delete removes some of its files and so makes the folder new again, and the first sweep an hour after that tries again.
- `ensureDir(dirPath)`: Ensure directory exists with recursive creation.
- `copyDirectoryNoSymlinks(srcDir, dstDir)`: Copy directory contents without symlinks, with path traversal protection.
- `normalizeUserSkillDir(userSkillDir)`: Normalize the user skill directory path (handles the legacy `skill` directory in the XDG config location, or `~/.config/opencode/skill` when XDG is unset, by selecting the plural `skills` directory when appropriate).

### Git Clone Helpers (`install.js`, `scan.js`)
- `cloneRepo({ cloneUrl, identity, credentialResolver, tempDir, ref })`: Clone git repository with preferred partial clone (`--filter=blob:none`) and fallback, on `ref` when the source names one. Uses non-interactive mode.

### SKILL.md Parsing (`scan.js`)
- `parseSkillMd(content)`: Parse YAML frontmatter from SKILL.md content. Returns `{ ok, frontmatter, warnings }`.

### Path Helpers (`install.js`)
- `toFsPath(repoDir, repoRelPosixPath)`: Convert POSIX path to filesystem path.
- `getTargetSkillDir({ scope, targetSource, workingDirectory, userSkillDir, skillName })`: Determine target installation directory based on scope (user/project), targetSource (opencode/agents), and skill name.

## Response Contracts

### Scan Skills Repository Response
- `ok`: Boolean indicating success.
- `normalizedRepo`: Normalized repo string (`owner/repo`).
- `effectiveSubpath`: Effective subpath used for scanning (may be from source string or defaultSubpath).
- `items`: Array of skill items with `{ repoSource, repoSubpath, skillDir, skillName, frontmatterName, description, installable, warnings }`. `skillDir` is the directory relative to the repository root and already includes `repoSubpath`, so a consumer that builds a repository path must not prepend the subpath again. `repoSubpath` describes the source (and is what a reinstall passes back), not a prefix to strip from `skillDir`.
- `error`: Error object with `{ kind, message }` on failure.

### Install Skills Response
- `ok`: Boolean indicating success.
- `installed`: Array of installed skills with `{ skillName, skillDir, scope, source }`; `skillDir` is the repo subpath the skill was copied from.
- `skipped`: Array of skipped skills with `{ skillName, reason }`.
- `error`: Error object with `{ kind, message, conflicts? }` on failure. Kinds: `authRequired`, `networkError`, `conflicts`, `invalidSource`, `unknown`.

### Parse Source Response
- `ok`: Boolean indicating success.
- `host`: Git host (e.g., `github.com`, `gitlab.com`).
- `owner`: Repository owner.
- `repo`: Repository name.
- `cloneUrlSsh`: SSH clone URL.
- `cloneUrlHttps`: HTTPS clone URL.
- `effectiveSubpath`: Subpath for scanning (from source string or options).
- `normalizedRepo`: Normalized repo string (`owner/repo`).
- `error`: Error object with `{ kind, message }` on failure.

## Notes for Contributors

### Adding a New Skill Source
1. Create a new subdirectory under `packages/web/server/lib/skills-catalog/` (e.g., `newsource/`).
2. Implement `scan.js` with a function that returns `{ ok, items, error? }` matching the SkillsCatalogItem contract.
3. Implement `install.js` with a function that accepts selections and returns `{ ok, installed, skipped, error? }`.
4. Add the source to `CURATED_SKILLS_SOURCES` in `curated-sources.js` if it should appear in the default catalog.
5. Update `packages/web/server/index.js` to import and wire up the new source.

### Skill Name Validation
- All skill names must match `/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/` (1-64 chars).
- Skill names are derived from directory basenames for git repos.
- Invalid names result in non-installable skills with appropriate warnings.

### Git cloning strategy
- Use sparse checkout to minimize checkout size: `sparse-checkout init`, `sparse-checkout set`, `checkout HEAD`.
- Keep managed credentials scoped to the selected provider endpoint. Do not fall back to System Git after a selected identity fails, and refuse a selected identity that names no credential.
- Only commands that reach the remote resolve the identity: the clone, the `checkout`, and the `show` fallback in `scan.js`, which fetch blobs lazily from the partial clone. Local commands (`sparse-checkout`, `ls-files`, `ls-tree`) run without it.
- Managed HTTPS and anonymous runs point `HOME`, `USERPROFILE`, and `XDG_CONFIG_HOME` at the null device, so an ambient `~/.netrc` cannot sign in as another account. SSH runs keep `HOME` for `known_hosts`.
- Preferred clone uses `--depth=1 --filter=blob:none` for partial clone with fallback to `--depth=1`.
- Always use non-interactive mode (`GIT_TERMINAL_PROMPT=0`) to avoid hangs.
- Managed SSH keys are injected as `-c core.sshCommand=<wrapper>` through the shared SSH wrapper; the operation's key copy is removed after the run.

### Conflict Resolution
- Installation checks for existing skills before downloading/cloning.
- Three conflict policies: `prompt`, `skipAll`, `overwriteAll`.
- Per-skill decisions override global policy via `conflictDecisions` map.
- Conflict response includes `{ skillName, scope, source }` for each conflict.

### Cache Management
- Cache keys include `normalizedRepo`, `subpath`, and `identityId` for isolation.
- Default TTL is 3 hours for both scan results and GitHub repository metadata.
- Scan and GitHub metadata caches persist to JSON files in the OpenChamber data dir, so app restarts and page refreshes reuse previous results instead of re-hitting GitHub.
- Scans run through a global concurrency limiter (2 at a time) with per-key in-flight deduplication.
- The refresh button passes `refresh: true` and bypasses the cache.

### Security Considerations
- Path traversal protection in `copyDirectoryNoSymlinks`: resolves real paths and checks containment.
- Symlinks are explicitly rejected to prevent escape from skill directory.
- Temporary directories are cleaned up in `finally` blocks, and the next scan or install removes any that were left (`removeStaleCatalogFolders`).

### Why the temp folder delete retries in its own loop and not with `fs.rm` `maxRetries`
On Windows a virus scanner or git's background maintenance can hold a file of the fresh clone right when the scan deletes it. A single delete with the error swallowed left one folder in the temp directory per catalog refresh (#5405). `fs.rm`'s own `maxRetries` retries again at every folder level, so a file held for good four levels deep in a clone kept one delete retrying for the whole 10 minutes the file stayed held on Windows (Node 24), and the catalog request waited on it. The loop in `remove-directory.js` gives up after about four seconds.

### Why old clones are swept and the delete does not wait longer
With an endpoint security agent on Windows, a fresh clone stayed held longer than the four seconds of retries on every scan, and each one stayed in the temp directory (#5497); folders about 50 minutes old deleted on the first try. Waiting longer would hold the catalog request for as long as the scanner keeps the files, which nobody controls. The sweep removes what was left at a later scan or install instead, along with folders earlier versions left. It skips folders younger than an hour: a folder's time changes only when its top-level entries do, and a scan that falls back to one `git show` per SKILL.md can keep using its clone for many minutes, in this process or in another window or app on the same machine. The prefixes cover the server and the extension because both write to the same temp directory.

The sweep reads entries with `lstat` and removes only real folders the current user owns. On a Linux `/tmp` shared with other users, a folder someone else made with a catalog name could hold a link swapped in while the recursive delete walks it, and the delete would then remove the link's target with our rights. Our own clones come from `mkdtemp`, which only we can write into. Windows reports no uid, and its temp directory is per user.

### Why the sparse listing names the subpath
After the sparse checkout the scan lists SKILL.md files with `git ls-files`. The index also holds the files the sparse checkout left out, and every one of those has no file on disk, so the scan read it with its own `git show`, and in a partial clone each of those fetches its blob from the remote. A source with a subpath in a large repository started thousands of Git processes per scan: 114 for Cursor's `pstack/skills`, about 5,700 for `sickn33/agentic-awesome-skills` with `skills` (#5446). It also listed skills from outside the subpath. `ls-files -- <subpath>` lists only what the checkout wrote, the same set the `ls-tree` fallback reads. `packages/vscode/src/skillsCatalog.ts` does the same.

### Error Handling
- All exported functions return `{ ok, ... }` result objects, not throw.
- Error kinds: `authRequired`, `networkError`, `conflicts`, `invalidSource`, `unknown`.
- Use `looksLikeAuthError` to detect SSH/HTTPS auth failures for better UX.
- Log errors to console for debugging but return structured errors to callers.

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Consider edge cases: non-existent repos, private repos without auth, missing SKILL.md files, invalid skill names, conflicts, network failures.

## Verification Commands
- Type-check: `bun run type-check`
- Lint: `bun run lint`
- Build: `bun run build`
