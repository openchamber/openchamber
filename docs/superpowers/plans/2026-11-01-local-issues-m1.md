# Local Issues Tracker (M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `local` tracker: issues as markdown files inside each project repo, indexed by the server, with board create/edit, and an agent session command.

**Architecture:** A new `packages/web/server/lib/local/` module implements the existing provider-neutral tracker contract (`../trackers/tracker-contract.d.ts`). A scanner reads each registered project's `issuesDir` (default `.issues`) on demand with a per-file `mtime+size` cache; the tracker maps local issues to the neutral shapes. The contract gains `create`/`edit` capability bits and two new routes; the UI renders create/edit only for trackers that declare them. An agent command template teaches agents to edit the same files directly.

**Tech Stack:** Node ESM (server, plain JS + JSDoc), vitest (server), isolated vitest (UI), React + i18n messages, zero new dependencies.

**Spec:** `issue-local-spec/本地Issue管理需求与设计方案.md` (v2.1). The plan argues from the spec; executors read both.

## Global Constraints

- Zero new dependencies (AGENTS.md). Frontmatter parsing is hand-written.
- Server tests: `bun run --cwd packages/web test -- <file>` (vitest). UI tests: `bun run --cwd packages/ui test` (isolated runner over `src`).
- Before every commit of source changes: `bun run check:changed` passes. Fix new findings; pre-existing backlog stays out of scope.
- Code, comments, and docs in English; i18n keys translated for en, nl, de, fr, es, ja, ko, pl, uk, tr, ar, he (pt-BR, zh-CN, zh-TW fall back to en).
- States are the six fixed categories: `triage`, `backlog`, `todo`, `in-progress`, `done`, `canceled`. `stateId` equals the category.
- The identifier in the filename is immutable. Server never renames issue files.
- All file writes use tmp + `fs.renameSync` atomic replace; writes re-read the file first and preserve unknown frontmatter keys and unknown body content.
- Scanner cache is per file (`mtimeMs` + `size`), never directory mtime (directory mtime does not change on content edits).
- `issuesDir` from settings must be a relative path without `..` segments and not absolute; anything else falls back to `.issues`.
- Session links write `kind: 'tracker'`; `liveSummaries` state objects include `type` (old-phone alias window).

## Review Focus

Inputs the spec implies but task tests must pin:

1. A hand-edited issue file with CRLF line endings or a BOM must not corrupt parse or duplicate blank lines on rewrite — `files.js` normalizes `\r\n` to `\n` and strips a leading BOM before parsing (Task 2).
2. `issuesDir` set to an absolute path or containing `..` must fall back to `.issues`, not escape the project (Task 8).
3. A copied file producing a duplicate identifier must be ignored (first file name in sort order wins) with a console warning, never shown twice (Task 3).
4. A user-mangled `## Comments` section must not crash comment append; the append recreates the section from its entries and preserves everything above it (Task 2).
5. Creating the first issue when `issuesDir` does not exist must mkdir it and still allocate number 1 after a lost race retries (Task 3).

---

### Task 1: Contract extension (create/edit capability bits)

**Files:**
- Modify: `packages/web/server/lib/trackers/tracker-contract.d.ts:87-100` (capabilities), `:135-168` (TrackerImplementation)
- Modify: `packages/web/server/lib/linear/tracker.js:30-40` (descriptor capabilities)
- Modify: `packages/ui/src/lib/trackers/types.ts:106-119` (capabilities mirror)
- Modify: `packages/ui/src/lib/trackers/descriptor.ts:40-50` (zod capabilities schema)
- Modify: `packages/ui/src/lib/trackers/descriptor.fixture.ts`
- Test: run existing suites only (this task adds no behavior)

**Interfaces:**
- Produces: `TrackerDescriptor.capabilities.create: boolean` and `.edit: boolean`; `TrackerImplementation.create(input): Promise<Connected<{ item: TrackerItem | null }>>` and `.edit(input): Promise<Connected<{ item: TrackerItem | null }>>` where `CreateTrackerItemInput = { containerId: string; title: string; description?: string | null; priority?: TrackerPriority | null; labels?: string[] }` and `EditTrackerItemInput = { id: string; title?: string; description?: string | null; priority?: TrackerPriority | null; labels?: string[] }`.
- Produces: UI `TrackerDescriptor['capabilities']` gains optional `create?: boolean; edit?: boolean` (optional, because a served descriptor from an older server omits them; consumers test `=== true`).

- [ ] **Step 1: Extend the server contract**

In `tracker-contract.d.ts`, inside `TrackerDescriptor['capabilities']` after `hostAccess: boolean;` add:

```ts
    /** UI can create items (POST items/create). */
    create: boolean;
    /** UI can edit item fields (POST items/edit). */
    edit: boolean;
```

Above `TrackerImplementation`, add the input types:

```ts
export type TrackerCreateItemInput = {
  containerId: string;
  title: string;
  description?: string | null;
  priority?: TrackerPriority | null;
  labels?: string[];
};
export type TrackerEditItemInput = {
  id: string;
  title?: string;
  description?: string | null;
  priority?: TrackerPriority | null;
  labels?: string[];
};
```

In `TrackerImplementation` after `updateState` add:

```ts
  create(input: TrackerCreateItemInput): Promise<Connected<{ item: TrackerItem | null }>>;
  edit(input: TrackerEditItemInput): Promise<Connected<{ item: TrackerItem | null }>>;
```

- [ ] **Step 2: Give Linear the explicit `false` bits**

In `packages/web/server/lib/linear/tracker.js`, inside `LINEAR_TRACKER_DESCRIPTOR.capabilities` after `hostAccess: true,` add `create: false,` and `edit: false,` so every served descriptor carries both keys.

- [ ] **Step 3: Mirror in the UI**

In `packages/ui/src/lib/trackers/types.ts` capabilities mirror add `create?: boolean;` and `edit?: boolean;` (optional). In `packages/ui/src/lib/trackers/descriptor.ts` zod capabilities schema add `create: z.boolean().optional(),` and `edit: z.boolean().optional(),` (optional is required here: an older server's Linear descriptor has neither key and must still parse). In `descriptor.fixture.ts` add `create: false, edit: false,` to each fixture's capabilities.

- [ ] **Step 4: Type-check and existing suites**

Run: `bun run --cwd packages/ui exec tsc --noEmit -p tsconfig.json` (or the repo's typecheck script; `package.json` is the source of truth) and `bun run --cwd packages/ui test`.
Expected: PASS. The UI parses the linear fixture with the new optional keys.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/trackers/tracker-contract.d.ts packages/web/server/lib/linear/tracker.js packages/ui/src/lib/trackers/types.ts packages/ui/src/lib/trackers/descriptor.ts packages/ui/src/lib/trackers/descriptor.fixture.ts
git commit -m "feat(trackers): create/edit capability bits in the tracker contract"
```

---

### Task 2: `files.js` — frontmatter, slugs, atomic writes, comments

**Files:**
- Create: `packages/web/server/lib/local/files.js`
- Test: `packages/web/server/lib/local/files.test.js`

**Interfaces:**
- Consumes: nothing outside the module (fs/path only).
- Produces (used by Tasks 3-5):
  - `STATES`, `PRIORITIES` (arrays as in Global Constraints)
  - `class LocalIssueError extends Error` with `error.userError = true`
  - `ISSUE_FILE_PATTERN = /^LOCAL-(\d{1,6})-([a-z0-9-]*)\.md$/`
  - `sanitizeSlug(input: string): string` — lowercase, keep `[a-z0-9-]`, collapse repeats, trim `-`, empty → `issue`, Windows reserved names (`con`, `prn`, `aux`, `nul`, `com1-9`, `lpt1-9`) prefixed `issue-`, max 60 chars
  - `issueFileName(number, slug): string` → `LOCAL-<n>-<slug>.md`
  - `normalizeSource(raw: string): string` — strip BOM, `\r\n` → `\n`
  - `parseIssueFile(raw: string, fileName: string): LocalIssue` — throws `LocalIssueError` on malformed frontmatter/identifier mismatch. `LocalIssue = { fileName, number, slug, identifier, fields: [string, string | string[] | null][], body: string }`. Preserves unknown frontmatter keys in `fields` order.
  - `serializeIssue(issue: LocalIssue): string` — frontmatter in original key order + body
  - `setFields(issue, patch: Record<string, string | string[] | null>): LocalIssue` — updates/adds known keys in place, `null` removes
  - `readIssue(dirPath, fileName): LocalIssue | null` — null when unreadable/unparseable (caller logs)
  - `writeIssue(dirPath, issue)` — serialize + tmp + `fs.renameSync`
  - `splitComments(body): { head: string, comments: { iso: string, source: string, text: string }[] }` — recognizes the `## Comments` section and `### <iso> · <source>` entries; a mangled section yields whatever entries parse, everything above the section is `head`
  - `appendComment(issue, { iso, source, text }): LocalIssue` — returns issue with the rebuilt `## Comments` section (normalized format) appended to `head`, `updatedAt` set to `iso`

- [ ] **Step 1: Write the failing tests**

Create `packages/web/server/lib/local/files.test.js`:

```js
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LocalIssueError, appendComment, issueFileName, parseIssueFile, readIssue,
  sanitizeSlug, splitComments, writeIssue,
} from './files.js';

const SAMPLE = `---
identifier: LOCAL-7
title: Fix login
state: todo
priority: high
labels: [bug, ui]
assignee: null
createdAt: 2026-11-01T08:00:00Z
updatedAt: 2026-11-01T08:00:00Z
feature: null
blockedBy: []
extra-key: keep-me
---

Body text.
`;

const write = (dir, name, content) => { fs.writeFileSync(path.join(dir, name), content, 'utf8'); };

describe('sanitizeSlug', () => {
  it('lowercases, strips illegal characters and collapses dashes', () => {
    expect(sanitizeSlug('Fix Login! (v2)')).toBe('fix-login-v2');
  });
  it('falls back to issue for empty and prefixes Windows reserved names', () => {
    expect(sanitizeSlug('')).toBe('issue');
    expect(sanitizeSlug('CON')).toBe('issue-con');
    expect(sanitizeSlug('nul')).toBe('issue-nul');
  });
});

describe('parseIssueFile', () => {
  it('round-trips fields, unknown keys and body', () => {
    const issue = parseIssueFile(SAMPLE, 'LOCAL-7-fix-login.md');
    expect(issue.identifier).toBe('LOCAL-7');
    expect(issue.number).toBe(7);
    expect(issue.fields).toContainEqual(['extra-key', 'keep-me']);
    expect(issue.body).toContain('Body text.');
    expect(serializeRound(issue)).toContain('extra-key: keep-me');
    function serializeRound() { return `---\n${issue.fields.map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n${issue.body}`; }
  });
  it('rejects an identifier that does not match the file name', () => {
    expect(() => parseIssueFile(SAMPLE, 'LOCAL-8-x.md')).toThrow(LocalIssueError);
  });
  it('normalizes CRLF and a BOM', () => {
    const issue = parseIssueFile(`\uFEFF${SAMPLE.replace(/\n/g, '\r\n')}`, 'LOCAL-7-fix-login.md');
    expect(issue.body).toContain('Body text.');
    expect(issue.body.includes('\r')).toBe(false);
  });
});

describe('comments', () => {
  it('appends a comment and recreates the section in normalized form', () => {
    const issue = parseIssueFile(SAMPLE, 'LOCAL-7-fix-login.md');
    const withComment = appendComment(issue, { iso: '2026-11-01T09:00:00Z', source: 'session a1b2', text: 'completed in 12m' });
    const { head, comments } = splitComments(withComment.body);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ iso: '2026-11-01T09:00:00Z', source: 'session a1b2', text: 'completed in 12m' });
    expect(head).toContain('Body text.');
  });
  it('survives a mangled Comments section', () => {
    const mangled = `${SAMPLE}## Comments\ngarbage without headings\n`;
    const issue = appendComment(parseIssueFile(mangled, 'LOCAL-7-fix-login.md'), { iso: '2026-11-01T09:00:00Z', source: 'ui', text: 'hello' });
    expect(splitComments(issue.body).comments).toHaveLength(1);
    expect(issue.body).toContain('Body text.');
  });
});

describe('readIssue/writeIssue', () => {
  it('writes atomically and reads back, preserving unknown keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-local-'));
    writeIssue(dir, { fileName: 'LOCAL-1-x.md', number: 1, slug: 'x', identifier: 'LOCAL-1', fields: [['identifier', 'LOCAL-1'], ['title', 'T'], ['custom', 'c']], body: 'B\n' });
    expect(fs.existsSync(path.join(dir, 'LOCAL-1-x.md'))).toBe(true);
    const issue = readIssue(dir, 'LOCAL-1-x.md');
    expect(issue.fields).toContainEqual(['custom', 'c']);
    expect(readIssue(dir, 'nope.md')).toBeNull();
  });
  it('returns null for an unparseable file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-local-'));
    write(dir, 'LOCAL-2-bad.md', 'no frontmatter here');
    expect(readIssue(dir, 'LOCAL-2-bad.md')).toBeNull();
  });
});

it('issueFileName matches the loader pattern', () => {
  expect(issueFileName(7, 'fix-login')).toMatch(/^LOCAL-7-[a-z0-9-]*\.md$/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd packages/web test -- server/lib/local/files.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `files.js`**

Write the module implementing every export above. Key decisions:

- Frontmatter block: file must start with `---\n`; the block ends at the next line that is exactly `---`. Each line `key: value`; `null` literal → `null`; `[a, b]` → array of trimmed strings; otherwise trimmed string (strip surrounding quotes if both ends match `'` or `"`).
- `parseIssueFile` validates `ISSUE_FILE_PATTERN` against `fileName` and that `fields.identifier` equals the name-derived identifier; throws `LocalIssueError` otherwise.
- `appendComment` rebuilds the section as: `## Comments\n` + per entry `### <iso> · <source>\n\n<text>\n` + `\n` between entries. It sets field `updatedAt` to `iso` (insert after `createdAt` if absent).
- `writeIssue` writes via `${filePath}.${process.pid}.${Date.now()}.tmp` + `fs.renameSync` (same pattern as `linear/auth.js:57-66`, but no `chmod 0o600` — issue files are project content, not secrets).
- `readIssue` returns `null` on any error and logs `console.warn` with the path.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd packages/web test -- server/lib/local/files.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/local/files.js packages/web/server/lib/local/files.test.js
git commit -m "feat(local): issue file format, frontmatter round-trip and atomic writes"
```

---

### Task 3: `scanner.js` — project scan, cache, numbering

**Files:**
- Create: `packages/web/server/lib/local/scanner.js`
- Test: `packages/web/server/lib/local/scanner.test.js`

**Interfaces:**
- Consumes: `files.js` exports from Task 2.
- Produces: `createLocalScanner({ listProjects })` where `listProjects(): Promise<{ id: string, path: string, label?: string | null, issuesDir?: string | null }[]>`. Returns `{ list, get, states, updateState, create, edit, liveSummaries, containers }`:
  - `list(options: { query?, state?, priority?, containerId?, cursor? })` → `{ issues: LocalIssue[], containerByIssue: Map<string, { id, name }>, cursor: string | null, hasMore: boolean }`; page size 100; cursor = `base64(JSON.stringify({ offset }))`; `state` `'open'` = not `done`/`canceled`, `'all'` = everything, otherwise the category must equal
  - `get(identifier)` → `{ issue, container } | null`
  - `states()` → the six categories with `position` = array index
  - `updateState(identifier, stateId)` → issue (throws `LocalIssueError` on unknown identifier/state)
  - `create(containerId, { title, description, priority, labels })` → issue; allocates max+1 with an existence-retry loop (re-check after each failed create, max 3 retries, then `LocalIssueError`); mkdirs the dir when missing
  - `edit(identifier, patch)` → issue; patch fields `title`/`description` (body replace)/`priority`/`labels`, sets `updatedAt`
  - `liveSummaries(identifiers)` → `[{ identifier, title, state: { name, category, type } }]` (`type` = category, for the old-phone alias window)
  - `containers()` → `[{ id, name }]` for projects that have a readable dir

- [ ] **Step 1: Write the failing tests**

Create `packages/web/server/lib/local/scanner.test.js`:

```js
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalIssueError } from './files.js';
import { createLocalScanner } from './scanner.js';

const issue = (n, title, state = 'todo', extra = '') => `---
identifier: LOCAL-${n}
title: ${title}
state: ${state}
priority: null
labels: []
assignee: null
createdAt: 2026-11-01T08:00:00Z
updatedAt: 2026-11-01T08:00:00Z
feature: null
blockedBy: []
${extra}---

Body of ${title}.
`;

let root;
let project;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-scan-'));
  project = { id: 'proj-1', path: root, label: 'Proj One' };
});

const scannerWith = async () => createLocalScanner({ listProjects: async () => [project] });

describe('list', () => {
  it('reads issues from .issues, filters by state and query, paginates', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    for (const n of [1, 2, 3]) fs.writeFileSync(path.join(dir, `LOCAL-${n}-t.md`), issue(n, `Title ${n}`, n === 3 ? 'done' : 'todo'));
    const scanner = await scannerWith();
    const open = await scanner.list({ state: 'open' });
    expect(open.issues.map((i) => i.identifier)).toEqual(['LOCAL-1', 'LOCAL-2']);
    const all = await scanner.list({ state: 'all', query: 'title 2' });
    expect(all.issues.map((i) => i.identifier)).toEqual(['LOCAL-2']);
    const page = await scanner.list({ state: 'all', cursor: Buffer.from(JSON.stringify({ offset: 2 })).toString('base64') });
    expect(page.issues).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });
  it('ignores a duplicated identifier and warns', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'First'));
    fs.writeFileSync(path.join(dir, 'LOCAL-1-b.md'), issue(1, 'Copy'));
    const warn = console.warn; console.warn = () => {};
    try {
      const scanner = await scannerWith();
      const { issues } = await scanner.list({ state: 'all' });
      expect(issues).toHaveLength(1);
      expect(issues[0].title).toBe('First');
    } finally { console.warn = warn; }
  });
  it('returns empty for a missing dir and a project that is unreadable', async () => {
    project.path = path.join(root, 'nonexistent');
    const scanner = await scannerWith();
    expect((await scanner.list({ state: 'all' })).issues).toEqual([]);
  });
});

describe('create', () => {
  it('mkdirs a missing dir and allocates max+1, honoring blockedBy/feature fields', async () => {
    const scanner = await scannerWith();
    const created = await scanner.create('proj-1', { title: 'New one', description: 'Desc', priority: 'high', labels: ['bug'], feature: 'login', blockedBy: ['LOCAL-2'] });
    expect(created.identifier).toBe('LOCAL-1');
    expect(fs.existsSync(path.join(root, '.issues', 'LOCAL-1-new-one.md'))).toBe(true);
    const second = await scanner.create('proj-1', { title: 'Second', description: null, priority: null, labels: [] });
    expect(second.identifier).toBe('LOCAL-2');
  });
  it('retries when the target file already exists (lost race)', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'LOCAL-1-taken.md'), issue(1, 'Taken'));
    const scanner = await scannerWith();
    const created = await scanner.create('proj-1', { title: 'Racer', description: null, priority: null, labels: [] });
    expect(created.identifier).toBe('LOCAL-2');
  });
});

describe('edit and updateState', () => {
  it('edits fields and body, bumps updatedAt, preserves unknown keys and comments', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'Old', 'todo', 'custom: keep\n'));
    const scanner = await scannerWith();
    const edited = await scanner.edit('LOCAL-1', { title: 'New', description: 'New body', priority: 'low', labels: ['x'] });
    expect(edited.title).toBe('New');
    expect(edited.state).toBe('todo');
    const raw = fs.readFileSync(path.join(dir, 'LOCAL-1-a.md'), 'utf8');
    expect(raw).toContain('custom: keep');
    expect(raw).toContain('New body');
  });
  it('moves state and rejects unknown identifier or state', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'T'));
    const scanner = await scannerWith();
    expect((await scanner.updateState('LOCAL-1', 'done')).state).toBe('done');
    expect(scanner.updateState('LOCAL-9', 'done')).rejects.toThrow(LocalIssueError);
    expect(scanner.updateState('LOCAL-1', 'nope')).rejects.toThrow(LocalIssueError);
  });
});

it('liveSummaries includes state.type for the alias window', async () => {
  const dir = path.join(root, '.issues');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'T', 'in-progress'));
  const scanner = await scannerWith();
  const [summary] = await scanner.liveSummaries(['LOCAL-1']);
  expect(summary.state).toEqual({ name: 'in-progress', category: 'in-progress', type: 'in-progress' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd packages/web test -- server/lib/local/scanner.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `scanner.js`**

- Cache: `Map<projectId, { issuesDir, files: Map<fileName, { mtimeMs, size }>, issues: Map<identifier, { issue, fileName }>, ignored: string[] }>`. On every scan: `fs.readdirSync(issuesDir)`, for each `ISSUE_FILE_PATTERN` match `fs.statSync` and reuse the cached parse only when `mtimeMs` and `size` are unchanged; otherwise `files.readIssue` (null → ignore + warn once per file name per scan).
- Duplicate identifiers: sort matching file names, keep the first per identifier, warn `console.warn('Ignoring duplicate local issue file:', path)`.
- `issuesDirOf(project)`: `typeof project.issuesDir === 'string' && project.issuesDir.trim() && !path.isAbsolute(project.issuesDir) && !project.issuesDir.split(/[\\/]/).includes('..') ? project.issuesDir : '.issues'`.
- Missing/unreadable dir → empty result for that project only.
- Sort issues by number ascending within a project; projects in `listProjects` order.
- `create` loop: compute number, `writeIssue`, and if the file came into existence between scan and write (`fs.existsSync`), increment and retry (max 3).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd packages/web test -- server/lib/local/scanner.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/local/scanner.js packages/web/server/lib/local/scanner.test.js
git commit -m "feat(local): project issues scanner with per-file cache and numbering"
```

---

### Task 4: `tracker.js` — descriptor and neutral mapping

**Files:**
- Create: `packages/web/server/lib/local/tracker.js`
- Test: `packages/web/server/lib/local/tracker.test.js`

**Interfaces:**
- Consumes: `createLocalScanner` (Task 3).
- Produces:
  - `LOCAL_TRACKER_DESCRIPTOR` (frozen) exactly as the spec §7 block (with `create: true, edit: true`).
  - `createLocalTracker({ listProjects })` → `TrackerImplementation` (JSDoc-typed) with `auth` (status always connected as `Local`; `start`/`disconnect`/`activate` throw `LocalIssueError('Not supported')`), `list`, `get`, `states`, `updateState`, `create`, `edit`, `liveSummaries`, `matchUrl`, `preferences` (Task 5), `sessionStatus` (Task 5).
  - Neutral mapping: `TrackerItemSummary = { provider: 'local', id: identifier, identifier, title, url: \`https://openchamber.local/tracker/local/\${identifier}\`, state: { id: category, name: category, category }, priority: priority ?? 'none', labels: labels.map((name, i) => ({ id: \`label-\${i}\`, name, color: null })), assignee: null, container, updatedAt }`; `get` adds `description` (body without the Comments section) and `comments` mapped from `splitComments` (`{ id: \`comment-\${i}\`, body: text, createdAt: iso, author: null }`).

- [ ] **Step 1: Write the failing tests**

Create `packages/web/server/lib/local/tracker.test.js`:

```js
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLocalTracker, LOCAL_TRACKER_DESCRIPTOR } from './tracker.js';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-track-')); });
const tracker = () => createLocalTracker({ listProjects: async () => [{ id: 'p1', path: root, label: 'P1' }] });

describe('descriptor', () => {
  it('is frozen and declares create/edit', () => {
    expect(Object.isFrozen(LOCAL_TRACKER_DESCRIPTOR)).toBe(true);
    expect(LOCAL_TRACKER_DESCRIPTOR.id).toBe('local');
    expect(LOCAL_TRACKER_DESCRIPTOR.capabilities.create).toBe(true);
    expect(LOCAL_TRACKER_DESCRIPTOR.capabilities.edit).toBe(true);
    expect(LOCAL_TRACKER_DESCRIPTOR.authMethods).toEqual([]);
  });
});

describe('auth', () => {
  it('is always connected as Local', async () => {
    const t = await tracker();
    expect(await t.auth.status()).toEqual({ connected: true, account: { id: 'local', name: 'Local', user: null, current: true } });
    await expect(t.auth.start()).rejects.toThrow();
  });
});

describe('list/get/create/edit/updateState', () => {
  it('creates, lists, gets with description and comments, edits, moves state', async () => {
    const t = await tracker();
    const { item } = await t.create({ containerId: 'p1', title: 'First', description: 'Body', priority: 'high', labels: ['bug'] });
    expect(item.identifier).toBe('LOCAL-1');
    expect(item.url).toBe('https://openchamber.local/tracker/local/LOCAL-1');
    expect(item.container).toEqual({ id: 'p1', key: null, name: 'P1' });
    expect(item.priority).toBe('high');
    const listed = await t.list({ state: 'open' });
    expect(listed).toMatchObject({ connected: true, hasMore: false, cursor: null });
    expect(listed.items).toHaveLength(1);
    const detail = await t.get('LOCAL-1');
    expect(detail.item.description).toBe('Body');
    const edited = await t.edit({ id: 'LOCAL-1', title: 'Renamed', labels: ['a', 'b'] });
    expect(edited.item.title).toBe('Renamed');
    expect(edited.item.labels.map((l) => l.name)).toEqual(['a', 'b']);
    const moved = await t.updateState({ id: 'LOCAL-1', stateId: 'done' });
    expect(moved.item.state.category).toBe('done');
    const empty = await t.get('LOCAL-99');
    expect(empty).toEqual({ connected: true, item: null });
  });
  it('returns connected:false-shaped UNSUPPORTED errors as user errors', async () => {
    const t = await tracker();
    await expect(t.create({ containerId: 'unknown', title: 'x' })).rejects.toThrow();
  });
});

describe('states and matchUrl', () => {
  it('returns the six fixed states with positions', async () => {
    const t = await tracker();
    const { states } = await t.states('p1');
    expect(states.map((s) => s.id)).toEqual(['triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled']);
    expect(states.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('matches issue URLs like the Linear rules', async () => {
    const t = await tracker();
    expect(t.matchUrl('https://openchamber.local/tracker/local/LOCAL-3')).toBe('LOCAL-3');
    expect(t.matchUrl('http://www.openchamber.local/tracker/local/LOCAL-3/')).toBe('LOCAL-3');
    expect(t.matchUrl('https://evil.example/tracker/local/LOCAL-3')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd packages/web test -- server/lib/local/tracker.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `tracker.js`**

- Descriptor: copy the block from spec §7 verbatim, `Object.freeze` at every level (mirror `linear/tracker.js:26-48`).
- `matchUrl`: `http(s)://` only, host without `www.`, equals `openchamber.local`, test the descriptor's `path` regex on the pathname, return `decodeURIComponent(match[1]) ?? null`.
- All thrown `LocalIssueError`s already carry `userError`, so `routes.js` maps them to 400.
- `list` options pass through to the scanner; `hasMore`/`cursor` come back from it.
- Leave `preferences` and `sessionStatus` methods delegating to modules created in Task 5 — implement this task with them throwing `new LocalIssueError('Not implemented yet')` and replace in Task 5 (the Task 4 tests do not touch them).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd packages/web test -- server/lib/local/tracker.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/local/tracker.js packages/web/server/lib/local/tracker.test.js
git commit -m "feat(local): tracker descriptor and neutral contract mapping"
```

---

### Task 5: `preferences.js` and `status-runtime.js`

**Files:**
- Create: `packages/web/server/lib/local/preferences.js`
- Create: `packages/web/server/lib/local/status-runtime.js`
- Test: `packages/web/server/lib/local/preferences.test.js`
- Test: `packages/web/server/lib/local/status-runtime.test.js`

**Interfaces:**
- Consumes: `scanner.get` + `files.appendComment` (Tasks 2-3).
- Produces:
  - `readLocalPreferences(): { sessionComments: boolean }` and `writeLocalPreferences({ sessionComments })` — stored in `$OPENCHAMBER_DATA_DIR/local-tracker.json` (same resolveDataDir + tmp+rename pattern as `linear/auth.js:13-23`, `OPENCHAMBER_DATA_DIR` env → else `~/.config/openchamber`), default `{ sessionComments: true }`
  - `createLocalSessionStatusRuntime({ post })` → `{ processPayload(payload), stop() }` mirroring `linear/status-runtime.js:37-64`: on `session.error` or `session.status` with `status.type === 'idle'` call `post({ kind: 'completed'|'failure', sessionId, sessionOrigin })` — read that file first and mirror its exact event mapping and dedupe guard.

- [ ] **Step 1: Write the failing tests**

`preferences.test.js`:

```js
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => { delete process.env.OPENCHAMBER_DATA_DIR; });

describe('local preferences', () => {
  it('defaults to sessionComments on and round-trips a write', async () => {
    process.env.OPENCHAMBER_DATA_DIR = globalThis.__ocTmpDataDir;
    const { readLocalPreferences, writeLocalPreferences } = await import('./preferences.js');
    expect(await readLocalPreferences()).toEqual({ sessionComments: true });
    await writeLocalPreferences({ sessionComments: false });
    expect(await readLocalPreferences()).toEqual({ sessionComments: false });
  });
});
```

(The suite's global setup writes `globalThis.__ocTmpDataDir = fs.mkdtempSync(...)`; create `packages/web/server/lib/local/setup.js` exporting a vitest `setupFiles` hook if the package has no such file yet — check `packages/web/vitest.config.*` for how linear tests get tmp dirs and follow that pattern instead if one exists.)

`status-runtime.test.js`: build a fake `post` recording calls, feed payloads copied from `linear/status-runtime.test.js` fixtures (`session.error`, `session.status` idle, an unrelated event), assert kinds `failure`/`completed` and that unrelated events post nothing; assert `stop()` is safe to call twice.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd packages/web test -- server/lib/local/preferences.test.js server/lib/local/status-runtime.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement both modules**

- `preferences.js`: `readJsonFile`/`writeJsonFile` helpers copied to this module (do not import from `linear/`); validate the parsed shape, fall back to defaults on anything unexpected.
- `status-runtime.js`: same payload handling as linear's runtime but calling the injected `post` (the tracker wires `sessionStatus.post`).
- Wire both into `tracker.js`: replace the Task 4 placeholders — `preferences: { get: readLocalPreferences, set: writeLocalPreferences }`; `sessionStatus.post(input)` resolves the issue via `scanner.get(input.identifier)`, returns `{ connected: true, posted: false, skipped: 'no-identifier' }` when absent or `sessionComments` is off, otherwise appends a comment `### <now ISO> · session <sessionId short>` with body `started`/`completed`/`failed` + `sessionOrigin` when present, returns `{ connected: true, posted: true }`; `sessionStatus.createRuntime: () => createLocalSessionStatusRuntime({ post })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd packages/web test -- server/lib/local/`
Expected: PASS (all local tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/local/preferences.js packages/web/server/lib/local/preferences.test.js packages/web/server/lib/local/status-runtime.js packages/web/server/lib/local/status-runtime.test.js packages/web/server/lib/local/tracker.js
git commit -m "feat(local): session comments runtime and preferences storage"
```

---

### Task 6: Registry entry, `local/index.js`, DOCUMENTATION.md

**Files:**
- Create: `packages/web/server/lib/local/index.js`
- Create: `packages/web/server/lib/local/DOCUMENTATION.md`
- Modify: `packages/web/server/lib/trackers/registry.js:15` (`BUILT_IN_TRACKERS`)
- Test: `packages/web/server/lib/trackers/registry.test.js` (extend if it exists; create otherwise)

**Interfaces:**
- Consumes: `LOCAL_TRACKER_DESCRIPTOR`, `createLocalTracker` (Task 4).
- Produces: `localTracker` registry entry; the registry lists `local` alongside `linear`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it } from 'vitest';
import { createTrackerRegistry } from './registry.js';
import { localTracker } from '../local/index.js';

describe('registry with the local tracker', () => {
  it('registers local after linear and answers its descriptor', () => {
    const registry = createTrackerRegistry(undefined, { foreignIds: ['github', 'gitlab'] });
    expect(registry.list()).toContain('local');
    expect(registry.descriptor('local').identifierPattern).toBe('^[A-Za-z][A-Za-z0-9]*-\\d+$');
  });
  it('builds when passed explicitly', () => {
    const registry = createTrackerRegistry([localTracker]);
    expect(registry.list()).toEqual(['local']);
  });
});
```

(Adjust the first case to the existing registry test's fixture style if `registry.test.js` already exists.)

- [ ] **Step 2: Run to verify failure** — `bun run --cwd packages/web test -- server/lib/trackers/registry.test.js` → FAIL (`local/index.js` missing).

- [ ] **Step 3: Implement**

`local/index.js`:

```js
import { LOCAL_TRACKER_DESCRIPTOR } from './tracker.js';

/** @typedef {import('../trackers/tracker-contract').TrackerEntry} TrackerEntry */

/** @type {TrackerEntry} */
export const localTracker = {
  descriptor: LOCAL_TRACKER_DESCRIPTOR,
  load: async () => {
    const [{ readSettingsFromDiskMigrated }, { createLocalTracker }] = await Promise.all([
      import('../opencode/settings-runtime.js'),
      import('./tracker.js'),
    ]);
    const listProjects = async () => {
      const settings = await readSettingsFromDiskMigrated();
      return (settings && Array.isArray(settings.projects)) ? settings.projects : [];
    };
    return createLocalTracker({ listProjects });
  },
};
```

In `registry.js` line 15: `export const BUILT_IN_TRACKERS = Object.freeze([linearTracker, localTracker]);` plus the import. `server/index.js` needs no change (registry build, session-status runtime and routes pick it up).

`DOCUMENTATION.md`: ownership statement (module owns issue md files under each project's `issuesDir`; registry id `local`), the routes it answers, the invariants (identifier immutable, six states, per-file cache, atomic writes, comments section format), and the pointer to the spec.

- [ ] **Step 4: Run tests** — `bun run --cwd packages/web test -- server/lib/local/ server/lib/trackers/` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/local/index.js packages/web/server/lib/local/DOCUMENTATION.md packages/web/server/lib/trackers/registry.js packages/web/server/lib/trackers/registry.test.js
git commit -m "feat(local): register the local tracker in the tracker registry"
```

---

### Task 7: Routes — `items/create` and `items/edit`

**Files:**
- Modify: `packages/web/server/lib/trackers/routes.js` (after `items/update` at :136)
- Test: `packages/web/server/lib/trackers/routes.test.js` (extend the existing suite if present)

**Interfaces:**
- Consumes: `tracker.create` / `tracker.edit` (Task 4), `handle()` + capability gate pattern (`routes.js:77-96`, `:130-136`).
- Produces: `POST /api/tracker/:provider/items/create` and `POST /api/tracker/:provider/items/edit` with the input shapes from Task 1; 404 `UNSUPPORTED` when the descriptor lacks the bit.

- [ ] **Step 1: Write the failing tests**

Following the existing routes test's harness (supertest-style app or direct `handle` invocation — copy the existing pattern), assert for a fake tracker: create requires `title` and `containerId` (400 `INVALID`), forwards to `tracker.create`, is 404 `UNSUPPORTED` when `capabilities.create !== true`; edit requires `id`, forwards, gates on `capabilities.edit`.

- [ ] **Step 2: Run to verify failure** — FAIL (routes absent).

- [ ] **Step 3: Implement** — insert after the `items/update` route:

```js
  const hasCreate = (descriptor) => descriptor.capabilities.create === true;
  const hasEdit = (descriptor) => descriptor.capabilities.edit === true;

  app.post('/api/tracker/:provider/items/create', parseJsonBody, handle('create item', ({ req, tracker }) => {
    const body = readBody(req);
    const title = readString(body.title);
    const containerId = readString(body.containerId);
    if (!title) throw invalid('title is required');
    if (!containerId) throw invalid('containerId is required');
    return tracker.create({
      containerId,
      title,
      description: readString(body.description) || null,
      priority: readString(body.priority) || null,
      labels: Array.isArray(body.labels) ? body.labels.filter(isString).map((label) => label.trim()).filter(Boolean) : [],
    });
  }, hasCreate));

  app.post('/api/tracker/:provider/items/edit', parseJsonBody, handle('edit item', ({ req, tracker }) => {
    const body = readBody(req);
    const id = readString(body.id);
    if (!id) throw invalid('id is required');
    const input = { id };
    if (body.title !== undefined) input.title = readString(body.title);
    if (body.description !== undefined) input.description = readString(body.description) || null;
    if (body.priority !== undefined) input.priority = readString(body.priority) || null;
    if (body.labels !== undefined) input.labels = Array.isArray(body.labels) ? body.labels.filter(isString).map((label) => label.trim()).filter(Boolean) : [];
    return tracker.edit(input);
  }, hasEdit));
```

- [ ] **Step 4: Run tests** — `bun run --cwd packages/web test -- server/lib/trackers/` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/trackers/routes.js packages/web/server/lib/trackers/routes.test.js
git commit -m "feat(trackers): items/create and items/edit routes behind capability bits"
```

---

### Task 8: Settings — per-project `issuesDir`

**Files:**
- Modify: `packages/web/server/lib/opencode/settings-normalization-runtime.js:208-250` (`sanitizeProjects`)
- Modify: `packages/web/server/lib/opencode/settings-normalization-runtime.test.js` (the `sanitizeProjects` describe block)
- Modify: `packages/ui/src/stores/useProjectsStore.ts:250` (mirror `sanitizeProjects`) and the `ProjectEntry` type in the same file

**Interfaces:**
- Produces: a project entry may carry `issuesDir?: string | null`; normalization keeps it only when it is a relative path without `..` segments (either separator), otherwise `null`.

- [ ] **Step 1: Write the failing test** — in the `sanitizeProjects` describe block add: keeps a valid `issuesDir` (`'plan/issues'`), nulls an absolute path, nulls `'../escape'`, nulls a non-string.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — mirror the conditional-expand style of the neighboring fields (:222-250): validate as above, expand `issuesDir` into the project object only when valid (store the trimmed value; absent → key omitted, scanner defaults). Mirror the same validation in `useProjectsStore.ts`'s `sanitizeProjects` and add `issuesDir?: string | null` to `ProjectEntry`.

- [ ] **Step 4: Run tests** — `bun run --cwd packages/web test -- server/lib/opencode/settings-normalization-runtime.test.js` and `bun run --cwd packages/ui test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/opencode/settings-normalization-runtime.js packages/web/server/lib/opencode/settings-normalization-runtime.test.js packages/ui/src/stores/useProjectsStore.ts
git commit -m "feat(settings): per-project issuesDir with relative-path validation"
```

---

### Task 9: UI — presentation entry and i18n

**Files:**
- Modify: `packages/ui/src/lib/trackers/presentation.ts:77-79`
- Modify: `packages/ui/src/lib/i18n/messages/first-party-integrations.i18n.ts` (+ its `.test.ts` `sameAsEnglish` whitelist)
- Test: existing i18n tests + presentation usage via typecheck

**Interfaces:**
- Consumes: `TrackerPresentation` shape (`presentation.ts:9-16`).
- Produces: `trackerPresentation('local')` returns a `local` entry; new keys `settings.integrations.local.*`, `sourceBoard.tracker.newIssue`, `sourceBoard.tracker.create.*`, `sourceBoard.tracker.edit` in all 12 locales.

- [ ] **Step 1: Add the presentation entry**

```ts
const LOCAL_PRESENTATION: TrackerPresentation = { icon: 'record-circle', copy: GENERIC_COPY, branchName: issueBranchName };
```

(Pick a better existing `IconName` from `@/components/icon/icons` if one fits a folder/box metaphor; do not invent an icon name.) Add to the Map: `['local', LOCAL_PRESENTATION]`.

- [ ] **Step 2: Add i18n keys**

In `first-party-integrations.i18n.ts` add to `en` (and translate for nl/de/fr/es/ja/ko/pl/uk/tr/ar/he; keep meaning literal):

```ts
'settings.integrations.local.title': 'Local issues',
'settings.integrations.local.description': 'Issues live as markdown files inside each project on this machine. Nothing to connect.',
'sourceBoard.tracker.newIssue': 'New issue',
'sourceBoard.tracker.create.title': 'New local issue',
'sourceBoard.tracker.create.project': 'Project',
'sourceBoard.tracker.create.submit': 'Create issue',
'sourceBoard.tracker.create.failed': 'Creating the issue failed.',
'sourceBoard.tracker.edit': 'Edit issue',
'sourceBoard.tracker.edit.failed': 'Saving the issue failed.',
```

Add `sourceBoard.tracker.newIssue`, `sourceBoard.tracker.create.*`, `sourceBoard.tracker.edit` keys also to the source-board messages module if the board's strings live there (`packages/ui/src/lib/i18n/messages/source-board.i18n.ts`) — keep each key in exactly one module; check where `sourceBoard.*` keys are defined first and follow it. Update the i18n test's `sameAsEnglish` whitelist for locales that legitimately keep English text.

- [ ] **Step 3: Run** — `bun run --cwd packages/ui test` → PASS; typecheck → PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/trackers/presentation.ts packages/ui/src/lib/i18n/messages/
git commit -m "feat(ui): local tracker presentation and copy"
```

---

### Task 10: UI — create/edit dialogs and board entries

**Files:**
- Create: `packages/ui/src/lib/trackers/mutations.ts`
- Create: `packages/ui/src/components/sourceBoard/TrackerIssueDialog.tsx`
- Modify: `packages/ui/src/components/sourceBoard/SourceBoardView.tsx` (list toolbar near `listRefreshButton` :673-686, preview actions near :714-742)
- Test: `packages/ui/src/lib/trackers/mutations.test.ts`, `packages/ui/src/components/sourceBoard/__tests__/TrackerIssueDialog.test.tsx` (follow the nearest existing component-test setup)

**Interfaces:**
- Consumes: `capabilities.create`/`capabilities.edit` (Task 1), the routes from Task 7, `useTrackerDescriptor` (`@/lib/trackers/registry`), `useTrackerSources` (`@/lib/trackers/sources`), container list from the active tracker tab.
- Produces: `createTrackerItem(provider, input: TrackerCreateItemInput)` and `editTrackerItem(provider, input: TrackerEditItemInput)` — both `POST` JSON to `/api/tracker/:provider/items/create|edit` using the same fetch/auth helper every other tracker call in `packages/ui/src/lib` uses (find it with `grep -rn "api/tracker/" packages/ui/src/lib | head`; do not introduce a new auth path); both return the parsed `TrackerItem` and throw on non-2xx. `TrackerIssueDialog` props: `{ provider: string; mode: 'create' | 'edit'; containers: { id: string; name: string }[]; initial?: TrackerItem; onDone: (item: TrackerItem) => void; onClose: () => void }`.

- [ ] **Step 1: Implement `mutations.ts` with its test** — thin fetch wrappers with the exact error behavior above; test them against a stubbed fetch.

- [ ] **Step 2: Implement `TrackerIssueDialog`** — fields: title (required), description (textarea), priority select (none/urgent/high/medium/low), project select (create mode only; containers prop), labels comma-separated input. Submit calls `createTrackerItem`/`editTrackerItem`, calls `onDone` with the returned item, shows the failed-copy key on error and keeps the text. Style follows the existing dialogs in this directory (e.g. `NewWorktreeDialog` import at `SourceBoardView.tsx:25`).

- [ ] **Step 3: Wire the entries in `SourceBoardView.tsx`**

- Next to `listRefreshButton` (:673-686): when the active list is a tracker tab (`previewItem?.source` handling and the tracker branch that renders `trailing={listRefreshButton}` at :792), and `useTrackerDescriptor(provider).capabilities.create === true` and the tracker is connected, render a second toolbar button (icon `plus`, label `sourceBoard.tracker.newIssue`) opening `TrackerIssueDialog` in create mode with that provider's containers (the sources module exposes the container list the scope picker already uses).
- In the preview actions cluster (:714-742, where `SourceBoardStateMenuItems` renders): when `capabilities.edit === true` and the previewed item is a tracker item of this provider, add an "Edit issue" action opening the dialog in edit mode with the item as `initial`; `onDone` triggers the same refresh path the state menu uses (`refreshRepositoryItem` / tracker list refresh at :634-663).

- [ ] **Step 4: Test** — component test renders the dialog, submits, and surfaces the failure copy; typecheck + `bun run --cwd packages/ui test` → PASS. Then run the app (`packages/web` dev server) and manually: open the board's Local tab on a project with a `.issues` dir, create an issue, see the file appear, edit it, see the diff in the repo. **This is the D3 + golden-path verification step; report what you clicked.**

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/trackers/mutations.ts packages/ui/src/lib/trackers/mutations.test.ts packages/ui/src/components/sourceBoard/
git commit -m "feat(ui): create and edit local issues from the source board"
```

---

### Task 11: UI — Settings card for a tracker with no auth methods

**Files:**
- Modify: `packages/ui/src/components/sections/integrations/TrackerSettings.tsx:160` (`canConnect`), `:269-281` (render branches)

**Interfaces:**
- Consumes: descriptor `authMethods: []`, auth status `{ connected: true, account }` from the tracker auth store.
- Produces: a tracker whose descriptor has zero auth methods renders a connected line ("Connected · Local issues") instead of the current unsupported-sign-in copy at :280-281.

- [ ] **Step 1: Write the failing test** — extend the existing `TrackerSettings` test: descriptor with `authMethods: []` + connected store renders the account name and no connect button and no `copy.unsupportedSignIn` string.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — branch order at :269: `authMethods.length === 0 && status.connected` → the connected line (reuse the account row markup); keep `canConnect` for oauth/token trackers. Keep the sessionComments preferences toggle visible (it reads `capabilities.sessionComments` already).

- [ ] **Step 4: Run** — `bun run --cwd packages/ui test` → PASS; verify in the running app's Settings that the Local card reads correctly.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/sections/integrations/TrackerSettings.tsx
git commit -m "feat(ui): settings card for trackers without auth methods"
```

---

### Task 12: UI — code references in the issue preview

**Files:**
- Modify: `packages/ui/src/components/views/TrackerItemView.tsx` (description render, around :56/:228)
- Test: a unit test for the reference parser

**Interfaces:**
- Produces: `parseCodeReferences(text: string): { text: string; filePath: string; line: number | null }[] | null` in `packages/ui/src/lib/trackers/codeReferences.ts` — matches `path/to/file.ext` optionally followed by `:NN`, where `ext` is 1-4 word characters and the path has at least one `/` or a known-code extension; returns null when the text contains no match.

- [ ] **Step 1: Write the failing parser test** — matches `src/foo.ts:42`, `packages/ui/src/lib/x.tsx`, rejects `v1.2.3`, plain words, URLs.

- [ ] **Step 2: Implement the parser, then render** — in `TrackerItemView`'s description render, split description segments on parsed references and render each as a button/link styled like existing file references, opening the file the same way repository file references do (reuse the open-file action the board uses for repository previews; find it via the checkout/file-open helper used by `useRepositoryReferenceList` consumers). Line number scrolls to the anchor if the existing helper supports it; otherwise open the file.

- [ ] **Step 3: Run** — `bun run --cwd packages/ui test` → PASS; manually verify a description containing `packages/web/server/lib/local/files.js:10` renders as a link and opens the file.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/trackers/codeReferences.ts packages/ui/src/lib/trackers/codeReferences.test.ts packages/ui/src/components/views/TrackerItemView.tsx
git commit -m "feat(ui): clickable code references in local issue descriptions"
```

---

### Task 13: Agent command template and docs

**Files:**
- Create: `.opencode/commands/local-issues.md`
- Create: `packages/docs/content/docs/local-issues.mdx` (mirror the frontmatter of a neighboring page, e.g. `issues-and-prs.mdx`)

**Interfaces:**
- Consumes: the spec §5.2 file format, §9 command behavior.

- [ ] **Step 1: Write the command template**

```markdown
---
description: Create, find and update local issues (markdown files in .issues/)
---

Manage local issues in this project. Issues live in `.issues/` as `LOCAL-<n>-<slug>.md` files.

$ARGUMENTS

Rules:

1. Creating: read `.issues/`, take the highest `LOCAL-<n>` number, use n+1. If the target file already exists, increment and retry. Slug is lowercase `[a-z0-9-]`, max 60 chars. Frontmatter (exactly these keys, in this order): `identifier`, `title`, `state` (one of `triage`, `backlog`, `todo`, `in-progress`, `done`, `canceled`), `priority` (`urgent`|`high`|`medium`|`low`|`null`), `labels` (array), `assignee` (`null`), `createdAt` and `updatedAt` (ISO), `feature` (`null`), `blockedBy` (array). The body below the frontmatter is the description.
2. Finding: list the directory, match by identifier prefix or search titles and bodies.
3. Updating state: edit the `state` frontmatter value only, and bump `updatedAt`.
4. Code references: when a session fixed something, append the touched file paths (with `:line` when useful) to the issue body so the UI can link them.
5. Never rename files: the identifier in the name is permanent.
```

- [ ] **Step 2: Write the docs page** — `packages/docs/content/docs/local-issues.mdx` covering: what local issues are (markdown in `<issuesDir>`, default `.issues`, per-project `issuesDir` setting in `settings.json`), what the board offers (create/edit/state/comments/session comments), the agent command (copy `.opencode/commands/local-issues.md` into your project, or your OpenCode user command dir), the triage-role mapping used by the `docs/agents/issue-tracker.md` convention, and that issue files are project content and leave the machine with `git push`.

- [ ] **Step 3: Verify** — run the OpenChamber dev server, start a session in a project, invoke `/local-issues create "Smoke test"` and confirm the agent creates a file the board lists.

- [ ] **Step 4: Commit**

```bash
git add .opencode/commands/local-issues.md packages/docs/content/docs/local-issues.mdx
git commit -m "docs: local issues guide and agent command template"
```

---

### Task 14: Full verification

- [ ] **Step 1:** `bun run --cwd packages/web test` and `bun run --cwd packages/ui test` → PASS.
- [ ] **Step 2:** `bun run check:changed` → PASS (fix new findings only).
- [ ] **Step 3:** Manual four-surface pass on web: board local tab (create/edit/state/comments), Settings card, session comments on a linked issue (start and finish a session against `LOCAL-1`), code reference link. Note anything the desktop/mobile builds need; the server routes are shared so they get the feature automatically, but the create/edit buttons only exist where this UI ships.
- [ ] **Step 4:** Final review per `openchamber-change-discipline` (`review` agent on the diff) and answer findings.
