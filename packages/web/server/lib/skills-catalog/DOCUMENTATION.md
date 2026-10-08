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

## Internal Helpers

The following functions are internal helpers used by exported functions:

### Git Helpers (`git.js`)
- `runGit(args, options)`: Execute a Git command with optional managed identity, credential resolver, timeout, and max buffer. HTTPS tokens go through the one-use local credential broker and never enter Git's arguments. Returns `{ ok, stdout, stderr, message, code, signal }`.
- `looksLikeAuthError(message)`: Detect if error message indicates authentication failure (permission denied, publickey, etc.).
- `assertGitAvailable()`: Check if git is available in PATH.

### Skill Name Validation (used in `install.js`, `scan.js`)
- `validateSkillName(skillName)`: Validate skill name against pattern `/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/` (1-64 chars, lowercase alphanumeric with hyphens).

### File System Helpers (`install.js`, `scan.js`)
- `safeRm(dir)`: Safely remove directory recursively (ignores errors).
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
- `items`: Array of skill items with `{ repoSource, repoSubpath, skillDir, skillName, frontmatterName, description, installable, warnings }`.
- `error`: Error object with `{ kind, message }` on failure.

### Install Skills Response
- `ok`: Boolean indicating success.
- `installed`: Array of installed skills with `{ skillName, scope, source }`.
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
- Temporary directories are cleaned up in `finally` blocks.

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
