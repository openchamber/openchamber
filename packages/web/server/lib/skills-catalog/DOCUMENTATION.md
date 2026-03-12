# Skills Catalog Module Documentation

## Purpose
This module provides skill discovery, scanning, and installation capabilities for OpenCode. It supports multiple skill sources including GitHub repositories and the ClawdHub registry, with caching and conflict resolution for skill installation.

## Entrypoints and structure
- `packages/web/server/lib/skills-catalog/`: Skills catalog module directory containing all skill-related functionality.
  - `cache.js`: In-memory cache for scan results with TTL support.
  - `curated-sources.js`: Predefined skill sources (Anthropic, ClawdHub).
  - `git.js`: Git operations helpers for cloning and auth error detection.
  - `install.js`: Skills installation from GitHub repositories.
  - `scan.js`: Skills scanning from GitHub repositories.
  - `source.js`: Source string parsing for GitHub repositories.
  - `clawdhub/`: ClawdHub registry integration.
    - `index.js`: Public API exports for ClawdHub.
    - `scan.js`: Scanning ClawdHub registry with pagination.
    - `install.js`: Installation from ClawdHub (ZIP download).
    - `api.js`: ClawdHub API client with rate limiting.

## Public API

The following functions are exported and used by the web server:

### Cache (`cache.js`)
- `getCacheKey({ normalizedRepo, subpath, identityId })`: Generate cache key for scan results.
- `getCachedScan(key)`: Retrieve cached scan result if not expired.
- `setCachedScan(key, value, ttlMs)`: Store scan result with TTL (default 30 minutes).
- `clearCache()`: Clear all cached scan results.

### Curated Sources (`curated-sources.js`)
- `getCuratedSkillsSources()`: Return list of curated skill sources (Anthropic, ClawdHub).
- `CURATED_SKILLS_SOURCES`: Constant array of predefined sources.

### Source Parsing (`source.js`)
- `parseSkillRepoSource(source, { subpath })`: Parse GitHub repository source string into structured object with SSH/HTTPS clone URLs, normalized repo, and effective subpath. Supports SSH URLs, HTTPS URLs, and shorthand `owner/repo[/subpath]` format.

### Git Repository Scanning (`scan.js`)
- `scanSkillsRepository({ source, subpath, defaultSubpath, identity })`: Scan GitHub repository for skills by cloning and analyzing SKILL.md files. Returns array of skill items with metadata.

### Git Repository Installation (`install.js`)
- `installSkillsFromRepository({ source, subpath, defaultSubpath, identity, scope, targetSource, workingDirectory, userSkillDir, selections, conflictPolicy, conflictDecisions })`: Install skills from GitHub repository. Supports user/project scopes, opencode/agents targets, conflict resolution (prompt/skipAll/overwriteAll), and sparse checkout for efficiency.

### ClawdHub Integration (`clawdhub/index.js`)
- `isClawdHubSource(source)`: Check if source string refers to ClawdHub.
- `scanClawdHub()`: Scan entire ClawdHub registry for all skills (paginated, max 20 pages).
- `scanClawdHubPage({ cursor })`: Scan a single page of ClawdHub results with cursor-based pagination.
- `installSkillsFromClawdHub({ scope, targetSource, workingDirectory, userSkillDir, selections, conflictPolicy, conflictDecisions })`: Install skills from ClawdHub by downloading ZIP files.
- `fetchClawdHubSkills({ cursor })`: Fetch paginated skills list from ClawdHub API.
- `fetchClawdHubSkillVersion(slug, version)`: Fetch specific skill version details.
- `fetchClawdHubSkillInfo(slug)`: Fetch skill metadata without version details.
- `downloadClawdHubSkill(slug, version)`: Download skill package as ZIP buffer.

### ClawdHub Constants (`clawdhub/index.js`)
- `CLAWDHUB_SOURCE_ID`: Source identifier for curated sources.
- `CLAWDHUB_SOURCE_STRING`: Source string format.

## Internal Helpers

The following functions are internal helpers used by exported functions:

### Git Helpers (`git.js`)
- `runGit(args, options)`: Execute git command with optional SSH identity, timeout, and max buffer. Returns `{ ok, stdout, stderr, message, code, signal }`.
- `looksLikeAuthError(message)`: Detect if error message indicates authentication failure (permission denied, publickey, etc.).
- `assertGitAvailable()`: Check if git is available in PATH.

### Skill Name Validation (used in `install.js`, `scan.js`, `clawdhub/install.js`)
- `validateSkillName(skillName)`: Validate skill name against pattern `/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/` (1-64 chars, lowercase alphanumeric with hyphens).

### File System Helpers (`install.js`, `scan.js`, `clawdhub/install.js`)
- `safeRm(dir)`: Safely remove directory recursively (ignores errors).
- `ensureDir(dirPath)`: Ensure directory exists with recursive creation.
- `copyDirectoryNoSymlinks(srcDir, dstDir)`: Copy directory contents without symlinks, with path traversal protection.
- `normalizeUserSkillDir(userSkillDir)`: Normalize user skill directory path (handles legacy `~/.config/opencode/skill` → `~/.config/opencode/skills` migration).

### Git Clone Helpers (`install.js`, `scan.js`)
- `cloneRepo({ cloneUrl, identity, tempDir })`: Clone GitHub repository with preferred partial clone (`--filter=blob:none`) and fallback. Uses non-interactive mode.

### SKILL.md Parsing (`scan.js`)
- `parseSkillMd(content)`: Parse YAML frontmatter from SKILL.md content. Returns `{ ok, frontmatter, warnings }`.

### Path Helpers (`install.js`)
- `toFsPath(repoDir, repoRelPosixPath)`: Convert POSIX path to filesystem path.
- `getTargetSkillDir({ scope, targetSource, workingDirectory, userSkillDir, skillName })`: Determine target installation directory based on scope (user/project), targetSource (opencode/agents), and skill name.

### ClawdHub API Helpers (`clawdhub/api.js`)
- `rateLimitedFetch(url, options)`: Fetch with rate limiting (120 req/min limit, 100ms delay between requests, exponential backoff on 429/500 errors).
- `mapClawdHubItem(item)`: Transform ClawdHub API response to SkillsCatalogItem format.

## Response Contracts

### Scan Skills Repository Response
- `ok`: Boolean indicating success.
- `normalizedRepo`: Normalized GitHub repo string (`owner/repo`).
- `effectiveSubpath`: Effective subpath used for scanning (may be from source string or defaultSubpath).
- `items`: Array of skill items with `{ repoSource, repoSubpath, skillDir, skillName, frontmatterName, description, installable, warnings }`.
- `error`: Error object with `{ kind, message }` on failure.

### Install Skills Response
- `ok`: Boolean indicating success.
- `installed`: Array of installed skills with `{ skillName, scope, source }`.
- `skipped`: Array of skipped skills with `{ skillName, reason }`.
- `error`: Error object with `{ kind, message, conflicts? }` on failure. Kinds: `authRequired`, `networkError`, `conflicts`, `invalidSource`, `unknown`.

### ClawdHub Scan Response
- `ok`: Boolean indicating success.
- `items`: Array of skill items with ClawdHub-specific metadata in `clawdhub` property.
- `nextCursor`: Pagination cursor for next page (only for `scanClawdHubPage`).
- `error`: Error object with `{ kind, message }` on failure.

### Parse Source Response
- `ok`: Boolean indicating success.
- `host`: GitHub host (`github.com`).
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
- Skill names are derived from directory basenames for GitHub repos and slugs for ClawdHub.
- Invalid names result in non-installable skills with appropriate warnings.

### Git Cloning Strategy
- Use sparse checkout to minimize clone size: `sparse-checkout init`, `sparse-checkout set`, `checkout HEAD`.
- Preferred clone uses `--depth=1 --filter=blob:none` for partial clone with fallback to `--depth=1`.
- Always use non-interactive mode (`GIT_TERMINAL_PROMPT=0`) to avoid hangs.
- SSH keys are injected via `core.sshCommand` in git config.

### Conflict Resolution
- Installation checks for existing skills before downloading/cloning.
- Three conflict policies: `prompt`, `skipAll`, `overwriteAll`.
- Per-skill decisions override global policy via `conflictDecisions` map.
- Conflict response includes `{ skillName, scope, source }` for each conflict.

### ClawdHub Integration
- ClawdHub API base URL: `https://clawdhub.com/api/v1`.
- Pagination uses cursor-based approach with `MAX_PAGES=20` safety limit.
- Rate limiting: 120 req/min with 100ms delay between requests.
- Downloaded skills are extracted from ZIP files using `adm-zip`.
- Always validate `SKILL.md` exists before installation.

### Cache Management
- Cache keys include `normalizedRepo`, `subpath`, and `identityId` for isolation.
- Default TTL is 30 minutes; can be overridden via `ttlMs` parameter.
- Cache is in-memory (not persisted across restarts).

### Security Considerations
- Path traversal protection in `copyDirectoryNoSymlinks`: resolves real paths and checks containment.
- Symlinks are explicitly rejected to prevent escape from skill directory.
- SSH key paths are trimmed but not escaped in `git.js` (assumes safe input from profiles).
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
