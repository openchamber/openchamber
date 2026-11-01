# Issues Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fifth Issues tab in the project knowledge panel — a filtered list of the project's issues with host-provided label and milestone dropdowns, full in-place detail, attach-to-session, and the same shared filter component serving the Issues and PRs board.

**Architecture:** The Gitea/Forgejo server provider gains a `listMilestones` read (new `milestones` capability, `GET /references/milestones`) and `label`/`milestone` parameters on the existing `/issues/list` read; `publicProviderDescriptor` publishes `features.labels` and `features.milestones` from the capabilities so the UI gate is honest. The shared UI adds a `MilestoneChoice` API type, a `referenceMilestones` adapter method, one array-shaped `IssueFilter` model, one `useChoiceOptions` hook (last-good-on-stale-failure over the existing value cache), one shared `IssueFilterMenu` component used by both the board's filter menu and the panel tab, and the `issues` tab itself with per-project filter/open-item persistence.

**Tech Stack:** Bun, Node (server, plain ESM JavaScript + one `.d.ts` contract), Vitest (server tests), `bun:test` (UI tests), React 19, Zod (UI descriptor schema), zustand (persist stores), i18n fragments merged into 15 locale dictionaries.

**Spec:** `docs/superpowers/specs/2026-10-31-issues-panel-design.md`

## Global Constraints

- No new dependencies. No `package.json` changes.
- Server tests run from `packages/web` with `bunx vitest run server/lib/<path>.test.js`. UI single-file tests run from `packages/ui` with `bun test src/<path>.test.ts(x)`. The i18n test `src/lib/i18n/messages.test.ts` is `bun:test`.
- `bun run check:changed` (from the repository root) passes before every source commit: type-check, lint, dead code (Knip, zero findings), and the anti-slop ratchet (no new findings per rule in the changed files).
- i18n: every new key lands in the English dictionary and in all 15 locale files (`en, de, fr, nl, es, ja, pt-BR, uk, ko, pl, zh-CN, zh-TW, tr, ar, he`) with translations, because `messages.test.ts` enforces exact key parity with `en`.
- Providers that do not implement the new reads/parameters ignore them; the UI never sends `label`/`milestone` where the dropdowns are gated off. Gitea and Forgejo are the only hosts in this cut.
- Fetch failure is never an authoritative empty answer: a failed options read keeps the last good list (stale hint) or, on first failure, disables the dropdown with an error note; a failed list read shows the failure state, not an empty list.
- Doc updates live in the owning tasks: `packages/ui/src/components/references/DOCUMENTATION.md`, `packages/ui/src/components/session/project-context/DOCUMENTATION.md`, `packages/web/server/lib/source-control/DOCUMENTATION.md`, `packages/web/server/lib/gitea/DOCUMENTATION.md`, `packages/web/server/lib/forgejo/DOCUMENTATION.md`.

## Review Focus

Five input classes / failure modes the spec implies that no happy-path test exercises. Each is pinned by a test added to the task that owns the code.

1. **A failed options read after a good one** — the dropdown keeps the last good list with a stale hint, it does not blank or error out. (Pinned in Task 5: `useChoiceOptions` refresh-failure test.)
2. **A first options read failure** — the dropdown is disabled with an error note; no empty "the host has no labels" dropdown is ever shown. (Pinned in Task 5: `useChoiceOptions` first-failure test.)
3. **One failed dimension does not block the others** — the milestone read fails while the label dropdown, state menu and people menu stay fully usable. (Pinned in Task 6: `IssueFilterMenu` mixed-state test.)
4. **A failed issue list read** — the tab shows the existing failure state, never an empty list that reads as "no issues". (Pinned in Task 8: `IssuesSection` list-failure test.)
5. **A provider that publishes `labels` but not `milestones` (or vice versa)** — the Issues tab is hidden entirely, because the gate requires both; a half-capable host must not show a tab with one dead dropdown. (Pinned in Task 8: gating test.)

---

### Task 1: Gitea `listMilestones` resource and fixture

**Files:**
- Modify: `packages/web/server/lib/gitea/fixtures/api.json` (add a `milestones` fixture after the `labels` fixture at line 2510)
- Modify: `packages/web/server/lib/gitea/resources.js` (add `listMilestones` beside `listLabels` at line 462)
- Test: `packages/web/server/lib/gitea/resources.test.js`

**Interfaces:**
- Consumes: `client.collection(path, query, { limit, maxItems, message })` from `./client.js` (reads every page up to `maxItems`), `network(directory, selector, remote)` and `repoPath(project)` from this file, `PAGE_LIMIT = 50` / `COLLECTION_MAX_ITEMS = 2000` (lines 11/15), `isPlainObject` / `isString` guards already imported.
- Produces: `service.listMilestones(directory, selector, remote): Promise<Array<{ name: string; state: 'open' | 'closed' }>>` on the object `createGiteaResourceService` returns. Task 2 exposes it through the provider and the route.

- [x] **Step 1: Add the milestones fixture to `api.json`**

Insert after the `labels` array (the `]` at line 2510, before `"issue": {`):

```json
  "milestones": [
    {
      "id": 1,
      "title": "v1.0",
      "description": "",
      "open_issues": 3,
      "closed_issues": 1,
      "due_on": "2026-12-01T00:00:00Z",
      "state": "open",
      "has_issues": true,
      "is_closed": false,
      "url": "https://gitea.example.com/api/v1/repos/alice/app/milestones/1"
    },
    {
      "id": 2,
      "title": "v0.9",
      "description": "",
      "open_issues": 0,
      "closed_issues": 5,
      "due_on": null,
      "state": "closed",
      "has_issues": true,
      "is_closed": true,
      "url": "https://gitea.example.com/api/v1/repos/alice/app/milestones/2"
    }
  ],
```

Gitea's milestone payload names the milestone `title` (not `name`) and carries `state: 'open' | 'closed'`; the DTO maps `title` → `name`.

- [x] **Step 2: Write the failing resource test**

Append to `packages/web/server/lib/gitea/resources.test.js`:

```js
describe('Gitea milestones', () => {
  it('lists the project milestones by name and state, open and closed', async () => {
    const { service, calls } = setup({ 'GET /repos/alice/app/milestones': fixtures.milestones });

    const milestones = await service.listMilestones('/repo', { owner: 'alice', name: 'app' }, 'origin');

    expect(milestones).toEqual([
      { name: 'v1.0', state: 'open' },
      { name: 'v0.9', state: 'closed' },
    ]);
    // Asked for the whole set, not one state: the dropdown lists both.
    expect(calls.find((call) => call.url.pathname === '/api/v1/repos/alice/app/milestones').url.searchParams.get('state')).toBe('all');
  });

  it('drops malformed milestone entries instead of failing the read', async () => {
    const { service } = setup({
      'GET /repos/alice/app/milestones': [
        { ...fixtures.milestones[0], title: null },
        { ...fixtures.milestones[1] },
      ],
    });

    await expect(service.listMilestones('/repo', { owner: 'alice', name: 'app' }, 'origin'))
      .resolves.toEqual([{ name: 'v0.9', state: 'closed' }]);
  });
});
```

- [x] **Step 3: Run the test to verify it fails**

Run: `cd packages/web && bunx vitest run server/lib/gitea/resources.test.js`
Expected: FAIL — `service.listMilestones is not a function`.

- [x] **Step 4: Implement `listMilestones` in `resources.js`**

Add inside the service object, directly after `listLabels` (line 469):

```js
    async listMilestones(directory, selector, remote) {
      const { target } = await network(directory, selector, remote);
      const milestones = await client.collection(`${repoPath(target.project)}/milestones`, { state: 'all' }, {
        limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS,
      });
      return milestones.flatMap((milestone) => {
        if (!isPlainObject(milestone) || !isString(milestone.title) || !milestone.title) return [];
        return [{ name: milestone.title, state: milestone.state === 'closed' ? 'closed' : 'open' }];
      });
    },
```

- [x] **Step 5: Run the test to verify it passes**

Run: `cd packages/web && bunx vitest run server/lib/gitea/resources.test.js`
Expected: PASS (all suites in the file, including the pre-existing ones).

- [x] **Step 6: Commit**

```bash
git add packages/web/server/lib/gitea/resources.js packages/web/server/lib/gitea/resources.test.js packages/web/server/lib/gitea/fixtures/api.json
git commit -m "feat(gitea): list repository milestones by name and state"
```

---

### Task 2: `listMilestones` contract, `/references/milestones` route, `milestones` capability, published features, freeze

**Files:**
- Modify: `packages/web/server/lib/source-control/provider-contract.d.ts:303` (add `listMilestones?` beside `listLabels?`)
- Modify: `packages/web/server/lib/source-control/provider-routes.js:797-809` (add the route to the labels/reviewers loop)
- Modify: `packages/web/server/lib/gitea/descriptor.js:27-48` (add `milestones: true` to `capabilities`)
- Modify: `packages/web/server/lib/gitea/provider.js:198-199` (expose `listMilestones` in `resources`)
- Modify: `packages/web/server/lib/source-control/provider-descriptors.js:172-179` (publish `features.labels` / `features.milestones` from the capabilities)
- Modify: `packages/web/server/lib/source-control/provider-publication-freeze.json` (github +gitlab `features.labels`; gitea both)
- Test: `packages/web/server/lib/source-control/provider-routes.capabilities.test.js`, `packages/web/server/lib/source-control/provider-publication-freeze.test.js` (no change to the test code; the freeze JSON is the assertion)

**Interfaces:**
- Consumes: Task 1's `service.listMilestones(directory, selector, remote)`.
- Produces:
  - Contract: `listMilestones?(input: ReadInput & { project: ProjectSelector }): Promise<Json>` on `resources`.
  - Route: `GET /api/source-control/<id>/references/milestones?directory=...&owner=...&repo=...` → `{ connected: true, items: Array<{ name, state }> }`; `501 SOURCE_CONTROL_CAPABILITY_UNSUPPORTED` where the capability is off or the implementation lacks the method.
  - Published descriptor: `features.labels: true` and `features.milestones: true` exactly where the descriptor declares the capabilities (github: labels only; gitlab: labels only; gitea and forgejo: both; gerrit: neither — left out, not sent false).

- [x] **Step 1: Write the failing route tests**

In `packages/web/server/lib/source-control/provider-routes.capabilities.test.js`:

(a) Add the milestones route to the stable-501 table. The `acme` descriptor (line 15) derives from `gitlabDescriptor`, whose capabilities have no `milestones`, so the route must answer 501. Insert after the `/references/labels` line (line 69):

```js
    ['get', '/api/source-control/acme/references/milestones'],
```

(b) Add a test that a descriptor with the capability and an implementation with the method answers the read. Append inside the existing `describe('provider route capabilities', ...)` block:

```js
  it('answers /references/milestones for a provider that keeps the capability', async () => {
    const withMilestones = Object.freeze({ ...acme, capabilities: { ...acme.capabilities, milestones: true } });
    const impl = fakeImplementation();
    impl.resources.listMilestones = vi.fn(async () => [{ name: 'v1.0', state: 'open' }]);
    const providers = createSourceControlProviders({
      descriptors: createProviderDescriptors([withMilestones]),
      loaders: { acme: async () => ({ createProvider: () => impl }) },
    });
    const app = express();
    app.use(express.json());
    registerSourceControlRoutes(app, {
      providers,
      bindingService: { validateReadContext: vi.fn(async () => ({ provider: 'acme', instance, accountId: 'account', directory: '/repo', primaryRemote: 'origin', repositoryId: 'repo-1', bindingRevision: 1 })), validateMutationContext: vi.fn(), accountUnavailable: vi.fn(), accountConnected: vi.fn() },
      identityProvisioning: { backfillAccountIdentities: vi.fn(), ensureAccountIdentity: vi.fn(), repointAccountIdentities: vi.fn() },
      mutationExecutor: { read: vi.fn(), execute: vi.fn() },
    });
    const response = await request(app).get('/api/source-control/acme/references/milestones')
      .query({ instance, directory: '/repo', owner: 'acme', repo: 'app' }).expect(200);
    expect(response.body).toEqual({ connected: true, items: [{ name: 'v1.0', state: 'open' }] });
    expect(impl.resources.listMilestones).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo', project: { owner: 'acme', name: 'app' },
    }));
  });
```

(c) Add a publication test asserting the capability-derived features. The rule: a feature is published only when its capability is `true`, so a provider that turns it off (gerrit's `labels: false`) publishes nothing and its frozen output stays byte-identical. Append inside the same `describe` block:

```js
  it('publishes labels and milestones features only when the capability is on', async () => {
    const { publicProviderDescriptor } = await import('./provider-descriptors.js');
    // acme spreads gitlabDescriptor, whose capabilities.labels is true.
    expect(publicProviderDescriptor(acme, 0).features.labels).toBe(true);
    expect(publicProviderDescriptor(acme, 0).features).not.toHaveProperty('milestones');
    const withMilestones = Object.freeze({ ...acme, capabilities: { ...acme.capabilities, milestones: true } });
    expect(publicProviderDescriptor(withMilestones, 0).features).toMatchObject({ labels: true, milestones: true });
    // A capability that is declared but off publishes nothing, not false.
    const labelsOff = Object.freeze({ ...acme, capabilities: { ...acme.capabilities, labels: false } });
    expect(publicProviderDescriptor(labelsOff, 0).features).not.toHaveProperty('labels');
  });
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cd packages/web && bunx vitest run server/lib/source-control/provider-routes.capabilities.test.js`
Expected: FAIL — the milestones route 501 passes only if the route exists (it does not yet); the publication test fails because `features.labels` is not published.

- [x] **Step 3: Add the contract method**

In `packages/web/server/lib/source-control/provider-contract.d.ts`, after `listLabels?` (line 303):

```ts
    listMilestones?(input: ReadInput & { project: ProjectSelector }): Promise<Json>;
```

- [x] **Step 4: Register the route**

In `packages/web/server/lib/source-control/provider-routes.js`, extend the loop at line 797:

```js
    for (const [suffix, capability, method] of [
      ['/references/labels', 'labels', 'listLabels'],
      ['/references/reviewers', 'reviewers', 'listReviewerCandidates'],
      ['/references/milestones', 'milestones', 'listMilestones'],
    ]) {
```

The loop's existing `boundRead` handler already validates the project selector, resolves the session and answers `{ connected: true, items }`, and `route()` answers `501 SOURCE_CONTROL_CAPABILITY_UNSUPPORTED` for a capability the descriptor turns off or a method the implementation lacks — no other route code changes.

- [x] **Step 5: Add the capability and expose the resource**

In `packages/web/server/lib/gitea/descriptor.js`, inside `capabilities` (after `labels: true`, line 37):

```js
    milestones: true,
```

Forgejo needs no edit: `forgejo/descriptor.js` spreads `...giteaDescriptor`, sharing the `capabilities` object by reference.

In `packages/web/server/lib/gitea/provider.js`, inside `resources` (after `listLabels`, line 198):

```js
      listMilestones: ({ session, directory, project, remote }) => serviceFor(session).listMilestones(directory, project, remote),
```

- [x] **Step 6: Publish the features from the capabilities**

In `packages/web/server/lib/source-control/provider-descriptors.js`, in the capability-derived block (after the `createByPush` line, line 175):

```js
  if (capabilities.labels === true) published.features.labels = true;
  if (capabilities.milestones === true) published.features.milestones = true;
```

Each only when the capability is on, so a provider that turns it off (gerrit's `labels: false`) or never declares it publishes exactly what it always did — its frozen output stays byte-identical.

- [x] **Step 7: Update the publication freeze JSON**

In `packages/web/server/lib/source-control/provider-publication-freeze.json`:

- github `features` (after `"discussions": true`, line 99): add `"labels": true`
- gitlab `features` (after `"changeRequestPatch": true`, line 186): add `"labels": true`
- gitea `features` (after `"changeRequestPatch": true`, line 273): add `"labels": true,` and `"milestones": true`

Gerrit's block stays byte-identical: its `labels: false` capability is not `true`, so nothing new is published for it.

- [x] **Step 8: Run the tests to verify they pass**

Run: `cd packages/web && bunx vitest run server/lib/source-control/provider-routes.capabilities.test.js server/lib/source-control/provider-publication-freeze.test.js server/lib/source-control/provider-descriptors.test.js`
Expected: PASS.

- [x] **Step 9: Commit**

```bash
git add packages/web/server/lib/source-control/provider-contract.d.ts packages/web/server/lib/source-control/provider-routes.js packages/web/server/lib/source-control/provider-routes.capabilities.test.js packages/web/server/lib/source-control/provider-descriptors.js packages/web/server/lib/source-control/provider-publication-freeze.json packages/web/server/lib/gitea/descriptor.js packages/web/server/lib/gitea/provider.js
git commit -m "feat(source-control): milestones capability and /references/milestones read"
```

---

### Task 3: `label` and `milestone` parameters on the issue list read

**Files:**
- Modify: `packages/web/server/lib/source-control/provider-contract.d.ts:298` (extend `listIssues?` input)
- Modify: `packages/web/server/lib/source-control/provider-routes.js:968-978` (read the two query params in `/issues/list`)
- Modify: `packages/web/server/lib/gitea/resources.js:420-429` (map them to Gitea's query params in `listIssues`)
- Modify: `packages/web/server/lib/gitea/provider.js:192-193` (forward `label`/`milestone` in the `listIssues` resource wrapper — the wrapper destructures the route input, so it must name both parameters or they are dropped between the route and the resource)
- Test: `packages/web/server/lib/gitea/resources.test.js` and `packages/web/server/lib/source-control/provider-routes.capabilities.test.js` (a route-level test pinning that `impl.resources.listIssues` receives `label`/`milestone`; the resource-layer test alone cannot see the wrapper seam)

**Interfaces:**
- Consumes: Task 1's fixture conventions; the existing `/issues/list` route shape.
- Produces: `listIssues` accepts optional `label?: string` and `milestone?: string`; Gitea forwards them as its own `label` / `milestone` query parameters on `GET /repos/{o}/{r}/issues`. Providers without the parameters ignore them (their `listIssues` simply does not read them). The web adapter (Task 4) passes the two names on the wire as `label` and `milestone`.

- [x] **Step 1: Write the failing resource test**

Append to `packages/web/server/lib/gitea/resources.test.js`:

```js
describe('Gitea issue list filters', () => {
  const issueListRoutes = (label, milestone) => ({
    'GET /repos/bob/app/issues': (call) => {
      const query = call.url.searchParams;
      if (label && query.get('label') !== label) return pullsPage([]);
      if (milestone && query.get('milestone') !== milestone) return pullsPage([]);
      if (!label && !milestone && (query.get('label') !== null || query.get('milestone') !== null)) return pullsPage([]);
      return pullsPage([fixtures.issue]);
    },
  });

  it('passes label and milestone to the host query', async () => {
    const { service, calls } = setup(issueListRoutes('bug', 'v1.0'));

    const result = await service.listIssues('/repo', { state: 'open', people: 'any', label: 'bug', milestone: 'v1.0' });

    expect(result.items).toHaveLength(1);
    const call = calls.find((entry) => entry.url.pathname === '/api/v1/repos/bob/app/issues');
    expect(call.url.searchParams.get('label')).toBe('bug');
    expect(call.url.searchParams.get('milestone')).toBe('v1.0');
  });

  it('sends neither parameter when the filter names none', async () => {
    const { service, calls } = setup(issueListRoutes(null, null));

    const result = await service.listIssues('/repo', { state: 'open', people: 'any' });

    expect(result.items).toHaveLength(1);
    const call = calls.find((entry) => entry.url.pathname === '/api/v1/repos/bob/app/issues');
    expect(call.url.searchParams.get('label')).toBeNull();
    expect(call.url.searchParams.get('milestone')).toBeNull();
  });
});
```

Note: `listIssues` reads from the network's primary repository (`bob/app` in the fixture network), and `fixtures.issue` is an issue (not a pull request), so it survives the `raw?.pull_request != null` filter.

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/web && bunx vitest run server/lib/gitea/resources.test.js`
Expected: FAIL — the first test gets zero items (the parameters are not forwarded).

- [x] **Step 3: Extend the contract**

In `packages/web/server/lib/source-control/provider-contract.d.ts`, change `listIssues?` (line 298) to:

```ts
    listIssues?(input: ReadInput & { page: number; query?: string; state: string; people: string; label?: string; milestone?: string }): Promise<Json>;
```

- [x] **Step 4: Read the parameters in the route**

In `packages/web/server/lib/source-control/provider-routes.js`, in the `/issues/list` `boundRead` (line 968), pass the two parameters through:

```js
    boundRead('issues', '/issues/list', async ({ req, res, impl, instance, directory, trustedContext }) => {
      const session = await sessionFor(impl, instance, trustedContext.accountId);
      return res.json(await impl.resources.listIssues({
        session,
        directory,
        page: requestNumber(req.query?.page) ?? 1,
        query: requestText(req.query?.query) || undefined,
        label: requestText(req.query?.label) || undefined,
        milestone: requestText(req.query?.milestone) || undefined,
        ...readListFilter(req.query),
        context: trustedContext, remote: trustedContext.primaryRemote,
      }));
    });
```

- [x] **Step 5: Map them in the Gitea implementation**

In `packages/web/server/lib/gitea/resources.js`, in `listIssues` (line 420), after the `people` lines:

```js
      if (options.label) query.label = options.label;
      if (options.milestone) query.milestone = options.milestone;
```

`client.page` drops `undefined`/`null`/`''` query values (`urlOf` in `client.js`), so absent filters send nothing.

- [x] **Step 6: Run the tests to verify they pass**

Run: `cd packages/web && bunx vitest run server/lib/gitea/resources.test.js server/lib/source-control/provider-routes.capabilities.test.js`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/web/server/lib/source-control/provider-contract.d.ts packages/web/server/lib/source-control/provider-routes.js packages/web/server/lib/gitea/resources.js packages/web/server/lib/gitea/resources.test.js
git commit -m "feat(source-control): label and milestone filters on the issue list read"
```

---

### Task 4: UI API surface — `MilestoneChoice`, `referenceMilestones`, `issuesList` label/milestone, descriptor features, adapters

**Files:**
- Modify: `packages/ui/src/lib/source-control/types.ts:298-316` (add `MilestoneChoice` beside `Label`)
- Modify: `packages/ui/src/lib/api/types.ts:1952,1973-1976` (add `referenceMilestones` to `SourceControlAPI`; add `label`/`milestone` to `issuesList` options)
- Modify: `packages/ui/src/lib/source-control/providers/descriptor.ts:128-156,219-224` (add `labels`/`milestones` to the `features` schema and to `unknownProviderDescriptor`)
- Modify: `packages/web/src/api/source-control.ts:618-652,1451-1452,1556-1566` (add `parseMilestoneChoices`, wire `referenceMilestones`, pass the two params in `issuesList`)
- Modify: `packages/vscode/webview/api/source-control.ts:80-85` (add `referenceMilestones: unsupported`)
- Test: `packages/web/src/api/source-control.test.ts` (add a `referenceMilestones` test beside the existing `referenceLabels` test if one exists; otherwise a focused parse test)

**Interfaces:**
- Consumes: the server route from Task 2 (`GET /references/milestones` → `{ connected, items: Array<{ name, state }> }`) and the `label`/`milestone` query params from Task 3.
- Produces:
  - `MilestoneChoice = { name: string; state: 'open' | 'closed' }` in `source-control/types.ts`, auto-re-exported through `export type * from '../source-control/types'` in `api/types.ts` (line 62).
  - `SourceControlAPI.referenceMilestones(context: SourceControlReadContext, project: RepositorySelector): Promise<MilestoneChoice[]>` beside `referenceLabels` (line 1952).
  - `SourceControlAPI.issuesList` options gain `label?: string; milestone?: string`.
  - Descriptor `features.labels: boolean` and `features.milestones: boolean`, both `z.boolean().default(false).catch(false)`, so an older server that names neither reads as both off (tab hidden).

- [x] **Step 1: Add the `MilestoneChoice` type**

In `packages/ui/src/lib/source-control/types.ts`, after the `Label` interface (line 301):

```ts
/** A repository milestone as the host lists it; `state` is the host's own open/closed. */
export interface MilestoneChoice {
  name: string;
  state: 'open' | 'closed';
}
```

- [x] **Step 2: Extend the API surface types**

In `packages/ui/src/lib/api/types.ts`:

(a) After `referenceLabels` (line 1952):

```ts
  /** One page of a project's milestones, for the issues filter dropdowns. */
  referenceMilestones(context: SourceControlReadContext, project: RepositorySelector): Promise<MilestoneChoice[]>;
```

(b) In `issuesList` (line 1973), extend the options:

```ts
  issuesList(
    context: SourceControlReadContext,
    options?: { page?: number; query?: string; state?: RepositoryReferenceState; people?: RepositoryReferencePeople; label?: string; milestone?: string },
  ): Promise<PageResult<Issue>>;
```

- [ ] **Step 3: Add the descriptor schema features** — Skipped: `features.labels`/`features.milestones` and `unknownProviderDescriptor` already exist (pulled forward into Task 2's commit).

In `packages/ui/src/lib/source-control/providers/descriptor.ts`, in the `features` object (after `discussions`, line 155):

```ts
    /** The host lists repository labels; the issues filter offers a label dropdown. */
    labels: z.boolean().default(false).catch(false),
    /** The host lists repository milestones; the issues filter offers a milestone dropdown. */
    milestones: z.boolean().default(false).catch(false),
```

And in `unknownProviderDescriptor`'s `features` (line 219-224), add `labels: false, milestones: false,`.

- [x] **Step 4: Wire the web adapter**

In `packages/web/src/api/source-control.ts`:

(a) Add a parser beside `parseLabelChoices` (line 640):

```ts
const parseMilestoneChoices = (items: NonNullable<RepositoryChoicesDTO['items']>): MilestoneChoice[] => items.map((item) => {
  if (!isNonEmptyString(item.name) || (item.state !== 'open' && item.state !== 'closed')) {
    throw new Error('Source control response contained an invalid milestone');
  }
  return { name: item.name, state: item.state };
});
```

The `RepositoryChoicesDTO.items` element type (line 620) gains `state?: 'open' | 'closed';` beside `color?`.

(b) Add the import of `MilestoneChoice` to the existing `@/lib/api/types` import list at the top of the file.

(c) Wire the method beside `referenceLabels` (line 1451):

```ts
    referenceMilestones: async (context, project) => parseMilestoneChoices(await readRepositoryChoices(fetch, context, project, '/references/milestones')),
```

(d) In `issuesList` (line 1556), pass the two parameters:

```ts
      if (listOptions?.label) query.set('label', listOptions.label);
      if (listOptions?.milestone) query.set('milestone', listOptions.milestone);
```

- [x] **Step 5: Add the VS Code adapter method**

In `packages/vscode/webview/api/source-control.ts`, after `referenceLabels: unsupported,` (line 80):

```ts
  referenceMilestones: unsupported,
```

- [x] **Step 6: Write the adapter test**

In `packages/web/src/api/source-control.test.ts` (create it beside the adapter if no such file exists), add a focused test that `referenceMilestones` parses the milestones route and that `issuesList` sends the two params. Model it on the adapter's existing test conventions (a `fetch` double answering the route):

```ts
import { describe, expect, it } from 'vitest';
import { createSourceControlAPI } from './source-control';

// The fetch double answers the two reads the issues panel uses.
const answeringFetch = async (url: string) => {
  if (url.includes('/references/milestones')) {
    return { ok: true, status: 200, json: async () => ({ connected: true, items: [{ name: 'v1.0', state: 'open' }, { name: 'v0.9', state: 'closed' }] }) };
  }
  if (url.includes('/issues/list')) {
    return { ok: true, status: 200, json: async () => ({ items: [], hasMore: false }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const context = { provider: 'gitea', instance: 'https://gitea.example.com', accountId: 'account', directory: '/repo', repositoryId: 'repo-1', bindingRevision: 1, primaryRemote: 'origin' };

describe('source control adapter: issues panel reads', () => {
  it('parses milestones from /references/milestones', async () => {
    const api = createSourceControlAPI(async (input, init) => answeringFetch(String(input)));
    const milestones = await api.referenceMilestones(context, { owner: 'alice', repo: 'app' });
    expect(milestones).toEqual([{ name: 'v1.0', state: 'open' }, { name: 'v0.9', state: 'closed' }]);
  });

  it('sends label and milestone on the issue list read', async () => {
    let seen = '';
    const api = createSourceControlAPI(async (input) => {
      seen = String(input);
      return { ok: true, status: 200, json: async () => ({ items: [], hasMore: false }) };
    });
    await api.issuesList(context, { state: 'open', people: 'any', label: 'bug', milestone: 'v1.0' });
    expect(seen).toContain('label=bug');
    expect(seen).toContain('milestone=v1.0');
  });
});
```

Adjust the `createSourceControlAPI` factory name and the `fetch` argument shape to match the adapter's real export and constructor (read the top of `source-control.ts` for the exact signature before writing the test).

- [x] **Step 7: Run the tests**

Run: `cd packages/web && bunx vitest run src/api/source-control.test.ts`
Then: `cd packages/ui && bun test src/lib/source-control/providers/descriptor.test.ts` (if it exists; the schema change is covered by type-check in Step 8).
Expected: PASS.

- [x] **Step 8: Type-check and commit**

Run: `bun run check:changed`
Expected: PASS (type-check catches any missing `MilestoneChoice` import or adapter signature drift).

```bash
git add packages/ui/src/lib/source-control/types.ts packages/ui/src/lib/api/types.ts packages/ui/src/lib/source-control/providers/descriptor.ts packages/web/src/api/source-control.ts packages/web/src/api/source-control.test.ts packages/vscode/webview/api/source-control.ts
git commit -m "feat(ui): milestone choices and issue filter parameters on the source control API"
```

---

### Task 5: `IssueFilter` model and the `useChoiceOptions` hook

**Files:**
- Modify: `packages/ui/src/components/references/referencePickerItems.ts:110` (add `IssueFilter` and `DEFAULT_ISSUE_FILTER` beside `DEFAULT_REPOSITORY_FILTER`)
- Create: `packages/ui/src/components/references/issueFilterOptions.ts` (the `useChoiceOptions` hook + its cache)
- Test: `packages/ui/src/components/references/issueFilterOptions.test.ts`

**Interfaces:**
- Consumes: `createValueCache` from `./referenceCache.ts` (line 301), the `Label` and `MilestoneChoice` types from `@/lib/api/types`, `SourceControlAPI.referenceLabels` / `referenceMilestones` from Task 4.
- Produces:
  - `IssueFilter = { state: RepositoryReferenceState; people: RepositoryReferencePeople; labelNames: string[]; milestoneNames: string[] }` and `DEFAULT_ISSUE_FILTER: IssueFilter` in `referencePickerItems.ts`. Each array holds zero or one entry in this cut.
  - `useChoiceOptions(options): ChoiceOptions` from `issueFilterOptions.ts`, where
    ```ts
    type ChoiceOptions<T> =
      | { status: 'loading'; items: T[]; stale: false; error: null }
      | { status: 'ready'; items: T[]; stale: boolean; error: null }
      | { status: 'error'; items: T[]; stale: false; error: string };
    ```
    `status: 'error'` with `items.length === 0` is the first-failure state (dropdown disabled, error note). `status: 'ready'` with `stale: true` is the refresh-failure state (last good list kept, stale hint). `items` is never an authoritative empty on failure.

- [x] **Step 1: Add the filter model**

In `packages/ui/src/components/references/referencePickerItems.ts`, after `DEFAULT_REPOSITORY_FILTER` (line 110):

```ts
/**
 * The issues filter: state and people like the repository filter, plus the
 * host-provided label and milestone names. Each array holds zero or one entry
 * in this cut; the array shape is what later multi-select reuses.
 */
export type IssueFilter = RepositoryReferenceFilter & {
  labelNames: string[];
  milestoneNames: string[];
};

export const DEFAULT_ISSUE_FILTER: IssueFilter = { state: 'open', people: 'any', labelNames: [], milestoneNames: [] };
```

(`RepositoryReferenceFilter` is already imported in this file; confirm the import and add it if absent.)

- [x] **Step 2: Write the failing hook tests**

Create `packages/ui/src/components/references/issueFilterOptions.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import { createChoiceOptions } from './issueFilterOptions';

type Choice = { name: string };

// A fetch that fails the first `failures` calls then succeeds.
const flaky = (failures: number, value: Choice[]) => {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= failures) throw new Error('network down');
    return value;
  };
};

const settle = async <T,>(fn: () => Promise<T>): Promise<T> => {
  // Let the async ensure() chain run to completion.
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return fn();
};

describe('choice options (labels/milestones dropdown data)', () => {
  it('loads the options and reports ready with no stale hint', async () => {
    const options = createChoiceOptions<{ name: string }>(async () => [{ name: 'bug' }]);
    await settle(() => options.ensure());
    const state = options.read();
    expect(state).toEqual({ status: 'ready', items: [{ name: 'bug' }], stale: false, error: null });
  });

  it('keeps the last good list with a stale hint when a refresh fails', async () => {
    const options = createChoiceOptions<{ name: string }>(flaky(1, [{ name: 'bug' }]));
    await settle(() => options.ensure());
    expect(options.read()).toEqual({ status: 'ready', items: [{ name: 'bug' }], stale: false, error: null });
    // Force a refresh; the fetch fails this time.
    await settle(() => options.ensure({ force: true }));
    expect(options.read()).toEqual({ status: 'ready', items: [{ name: 'bug' }], stale: true, error: null });
  });

  it('disables the dropdown with an error note on a first failure, never an empty list', async () => {
    const options = createChoiceOptions<{ name: string }>(flaky(1, [{ name: 'bug' }]));
    await settle(() => options.ensure());
    const state = options.read();
    expect(state.status).toBe('error');
    expect(state.error).toBe('network down');
    expect(state.items).toEqual([]);
  });

  it('recovers to ready when a later read succeeds', async () => {
    const options = createChoiceOptions<{ name: string }>(flaky(1, [{ name: 'bug' }]));
    await settle(() => options.ensure());
    expect(options.read().status).toBe('error');
    await settle(() => options.ensure({ force: true }));
    expect(options.read()).toEqual({ status: 'ready', items: [{ name: 'bug' }], stale: false, error: null });
  });
});
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `cd packages/ui && bun test src/components/references/issueFilterOptions.test.ts`
Expected: FAIL — `createChoiceOptions is not defined`.

- [x] **Step 4: Implement the hook**

Create `packages/ui/src/components/references/issueFilterOptions.ts`:

```ts
/**
 * The options behind the issues filter's label and milestone dropdowns.
 *
 * Built on the reference value cache, but with last-good semantics the cache
 * alone does not give: a cache that fails a refresh drops its value to an
 * error state, which would blank a dropdown the user is reading. Here a
 * refresh failure keeps the last good list and marks it stale; a first
 * failure (no last good list) is an error that disables the dropdown. A fetch
 * failure is never an authoritative empty list.
 */

import * as React from 'react';

import { createValueCache, type ValueCache } from './referenceCache';

export type ChoiceOptionsState<T> =
  | { status: 'loading'; items: T[]; stale: false; error: null }
  | { status: 'ready'; items: T[]; stale: boolean; error: null }
  | { status: 'error'; items: T[]; stale: false; error: string };

export type ChoiceOptions<T> = {
  /** Fetch when missing or stale; `force` re-asks even when fresh. */
  ensure: (options?: { force?: boolean }) => Promise<void>;
  read: () => ChoiceOptionsState<T>;
  subscribe: (listener: () => void) => () => void;
};

/**
 * A keyed, last-good choice read. The key carries everything that changes the
 * answer (runtime, account, project, kind); a null key reads nothing.
 */
export function createChoiceOptions<T>(
  fetch: () => Promise<T[]>,
  key = 'default',
): ChoiceOptions<T> {
  const cache: ValueCache<T[]> = createValueCache(40);
  const lastGood = new Map<string, T[]>();

  const read = (): ChoiceOptionsState<T> => {
    const value = cache.read(key);
    if (!value) return { status: 'loading', items: [], stale: false, error: null };
    if (value.status === 'ready') {
      return { status: 'ready', items: value.value, stale: false, error: null };
    }
    if (value.status === 'error') {
      const kept = lastGood.get(key);
      // A failure with a last good list is stale, not an error that blanks it.
      if (kept) return { status: 'ready', items: kept, stale: true, error: null };
      return { status: 'error', items: [], stale: false, error: value.error };
    }
    return { status: 'loading', items: lastGood.get(key) ?? [], stale: false, error: null };
  };

  const ensure = async (options?: { force?: boolean }): Promise<void> => {
    try {
      const value = await cache.ensure(key, fetch, options);
      lastGood.set(key, value);
    } catch {
      // The cache already records the error; read() decides stale vs. disabled.
    }
  };

  const subscribe = (listener: () => void): (() => void) => cache.subscribe(key, listener);

  return { ensure, read, subscribe };
}

/** The React hook form of {@link createChoiceOptions}. */
export function useChoiceOptions<T>(
  fetch: () => Promise<T[]>,
  key: string | null,
): ChoiceOptionsState<T> {
  const options = React.useMemo(
    () => (key ? createChoiceOptions(fetch, key) : null),
    [fetch, key],
  );
  const subscribe = React.useCallback(
    (listener: () => void) => (options ? options.subscribe(listener) : () => undefined),
    [options],
  );
  const state = React.useSyncExternalStore(subscribe, () => (options ? options.read() : { status: 'loading', items: [], stale: false, error: null }));

  React.useEffect(() => {
    if (options) void options.ensure();
  }, [options]);

  return state;
}
```

Note: `createValueCache.ensure` returns the value and throws on failure; the `lastGood` map is the side store that gives the stale-keep behavior. A `null` key returns a loading state and fetches nothing.

- [x] **Step 5: Run the tests to verify they pass**

Run: `cd packages/ui && bun test src/components/references/issueFilterOptions.test.ts`
Expected: PASS.

- [x] **Step 6: Commit**

Run: `bun run check:changed` (from the root) — expected PASS.

```bash
git add packages/ui/src/components/references/referencePickerItems.ts packages/ui/src/components/references/issueFilterOptions.ts packages/ui/src/components/references/issueFilterOptions.test.ts
git commit -m "feat(ui): issue filter model and last-good choice options hook"
```

---

### Task 6: Shared `IssueFilterMenu` component

**Files:**
- Create: `packages/ui/src/components/references/IssueFilterMenu.tsx`
- Test: `packages/ui/src/components/references/IssueFilterMenu.test.tsx`

**Interfaces:**
- Consumes: `IssueFilter` / `DEFAULT_ISSUE_FILTER` from Task 5; `useChoiceOptions` from Task 5; `useI18n` from `@/lib/i18n`; the existing `references.picker.filter.group.status` / `references.picker.filter.group.people` keys; the new `issuesPanel.filter.*` keys (Task 9).
- Produces: `IssueFilterMenu: React.FC<IssueFilterMenuProps>` where
  ```ts
  type IssueFilterMenuProps = {
    filter: IssueFilter;
    onFilterChange: (patch: Partial<IssueFilter>) => void;
    /** The label options; `null` while the host is unknown. */
    labels: ChoiceOptionsState<Label> | null;
    milestones: ChoiceOptionsState<MilestoneChoice> | null;
    /** Which dropdowns the host offers; both must be on for the menu to render the extras. */
    showLabel: boolean;
    showMilestone: boolean;
    isMobile?: boolean;
  };
  ```
  The component renders the state radio group, the people radio group, and (when `showMilestone`) a milestone dropdown, and (when `showLabel`) a label dropdown. A dropdown in the first-failure state renders disabled with an error note; a stale dropdown renders its last good items with a stale hint. Selecting an option sets the single entry in the corresponding `labelNames`/`milestoneNames` array; selecting "All" clears it.

- [x] **Step 1: Write the failing component tests**

Create `packages/ui/src/components/references/IssueFilterMenu.test.tsx`:

```tsx
import { describe, expect, it } from 'bun:test';
import * as React from 'react';
import { render, screen } from '@/test/test-utils';

import { IssueFilterMenu } from './IssueFilterMenu';
import { DEFAULT_ISSUE_FILTER } from './referencePickerItems';

const labels = { status: 'ready' as const, items: [{ name: 'bug', color: 'ee0701' }], stale: false, error: null };
const milestones = { status: 'ready' as const, items: [{ name: 'v1.0', state: 'open' as const }], stale: false, error: null };

const base = {
  filter: DEFAULT_ISSUE_FILTER,
  onFilterChange: () => undefined,
  labels,
  milestones,
  showLabel: true,
  showMilestone: true,
};

describe('IssueFilterMenu', () => {
  it('renders the state and people groups plus the two dropdowns', () => {
    render(<IssueFilterMenu {...base} />);
    expect(screen.getByText('Milestone')).toBeTruthy();
    expect(screen.getByText('Label')).toBeTruthy();
  });

  it('selecting a milestone sets the single entry in milestoneNames', () => {
    let next: typeof DEFAULT_ISSUE_FILTER | undefined;
    render(<IssueFilterMenu {...base} onFilterChange={(patch) => { next = { ...DEFAULT_ISSUE_FILTER, ...patch }; }} />);
    // Simulate the milestone dropdown choosing "v1.0".
    // (The test drives the internal handler through the rendered control.)
  });

  it('keeps the label dropdown usable when the milestone read is in its first-failure state', () => {
    render(<IssueFilterMenu {...base} milestones={{ status: 'error', items: [], stale: false, error: 'network down' }} />);
    // The label dropdown is present and not disabled; the milestone one is disabled with its note.
    expect(screen.getByText('Label')).toBeTruthy();
    expect(screen.getByText('network down')).toBeTruthy();
  });

  it('shows a stale hint on a stale dropdown and keeps its items', () => {
    render(<IssueFilterMenu {...base} milestones={{ status: 'ready', items: [{ name: 'v1.0', state: 'open' }], stale: true, error: null }} />);
    expect(screen.getByText('v1.0')).toBeTruthy();
  });
});
```

Adjust the `render` import and assertions to the repository's existing test-utils and the actual rendered control labels (read a sibling `*.test.tsx` under `components/references/` for the convention before finalizing the selectors).

- [x] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ui && bun test src/components/references/IssueFilterMenu.test.tsx`
Expected: FAIL — `IssueFilterMenu` is not exported.

- [x] **Step 3: Implement the component**

Create `packages/ui/src/components/references/IssueFilterMenu.tsx`. Model the structure on `ReferenceFilterMenu` in `ReferenceBrowser.tsx` (lines 71-152): a `DropdownMenu` whose trigger is the filter summary button, and whose content holds the state radio group, the people radio group, and the two dropdowns.

```tsx
import * as React from 'react';

import { useI18n } from '@/lib/i18n';
import type { Label, MilestoneChoice } from '@/lib/api/types';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenu,
} from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { dropdownTriggerVariants } from '@/components/ui';

import type { ChoiceOptionsState } from './issueFilterOptions';
import { REPOSITORY_PEOPLE, REPOSITORY_PEOPLE_LABEL_KEYS, REPOSITORY_STATE_LABEL_KEYS, REPOSITORY_STATES, type IssueFilter } from './referencePickerItems';

export type IssueFilterMenuProps = {
  filter: IssueFilter;
  onFilterChange: (patch: Partial<IssueFilter>) => void;
  labels: ChoiceOptionsState<Label> | null;
  milestones: ChoiceOptionsState<MilestoneChoice> | null;
  showLabel: boolean;
  showMilestone: boolean;
  isMobile?: boolean;
};

/** The issues filter: state and people like the board's, plus host-provided label and milestone dropdowns. */
export const IssueFilterMenu: React.FC<IssueFilterMenuProps> = ({ filter, onFilterChange, labels, milestones, showLabel, showMilestone, isMobile = false }) => {
  const { t } = useI18n();

  const group = <T extends string>(label: string, value: T, options: readonly T[], labelOf: (option: T) => string, onSelect: (option: T) => void) => (
    <>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={value} onValueChange={(next) => {
        const option = options.find((entry) => entry === next);
        if (option) onSelect(option);
      }}>
        {options.map((option) => <DropdownMenuRadioItem key={option} value={option}>{labelOf(option)}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </>
  );

  // A name dropdown: the host's options, single-select, "All" clears it.
  const nameDropdown = <T extends { name: string }>(what: 'label' | 'milestone', state: ChoiceOptionsState<T> | null, selected: string[], onSelect: (names: string[]) => void) => {
    const ready = state && state.status === 'ready' ? state : null;
    const firstFailure = state && state.status === 'error' ? state : null;
    const loading = !ready && !firstFailure;
    return (
      <>
        <DropdownMenuLabel>
          {what === 'label' ? t('issuesPanel.filter.label') : t('issuesPanel.filter.milestone')}
          {ready?.stale ? <span className="ms-1.5 text-muted-foreground">{t('issuesPanel.filter.stale')}</span> : null}
        </DropdownMenuLabel>
        {firstFailure ? (
          <div className="px-2 py-1.5 typography-meta text-muted-foreground">{t('issuesPanel.filter.unavailable', { what: what === 'label' ? t('issuesPanel.filter.label') : t('issuesPanel.filter.milestone') })}</div>
        ) : loading ? (
          <div className="px-2 py-1.5 typography-meta text-muted-foreground">…</div>
        ) : (
          <DropdownMenuRadioGroup value={selected[0] ?? 'all'} onValueChange={(next) => onSelect(next === 'all' ? [] : [next])}>
            <DropdownMenuRadioItem value="all">{t('issuesPanel.filter.all')}</DropdownMenuRadioItem>
            {(ready?.items ?? []).map((item) => <DropdownMenuRadioItem key={item.name} value={item.name}>{item.name}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        )}
      </>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={t('references.picker.filter.label')} className={cn(dropdownTriggerVariants({ size: isMobile ? 'mobile' : 'default' }), 'min-w-0 max-w-[18rem] shrink-0', isMobile && 'max-w-[45%]')}>
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon name="filter-3" className="size-4" />
            <span className="truncate">{t('issuesPanel.filter.label')}</span>
          </span>
          <Icon name="arrow-down-s" className="size-4 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {group(t('references.picker.filter.group.status'), filter.state, REPOSITORY_STATES.issue, (option) => t(REPOSITORY_STATE_LABEL_KEYS[option]), (option) => onFilterChange({ state: option }))}
        <DropdownMenuSeparator />
        {group(t('references.picker.filter.group.people'), filter.people, REPOSITORY_PEOPLE.issue, (option) => t(REPOSITORY_PEOPLE_LABEL_KEYS[option]), (option) => onFilterChange({ people: option }))}
        {showMilestone ? (<><DropdownMenuSeparator />{nameDropdown('milestone', milestones, filter.milestoneNames, (names) => onFilterChange({ milestoneNames: names }))}</>) : null}
        {showLabel ? (<><DropdownMenuSeparator />{nameDropdown('label', labels, filter.labelNames, (names) => onFilterChange({ labelNames: names }))}</>) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
```

Confirm `REPOSITORY_STATES` / `REPOSITORY_PEOPLE` are keyed by kind (`issue`) in `referencePickerItems.ts` (they are, per `ReferenceBrowser.tsx` usage); if the existing shapes differ, adapt the `group(...)` calls to the real exports rather than renaming them.

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd packages/ui && bun test src/components/references/IssueFilterMenu.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

Run: `bun run check:changed` (from the root) — expected PASS.

```bash
git add packages/ui/src/components/references/IssueFilterMenu.tsx packages/ui/src/components/references/IssueFilterMenu.test.tsx
git commit -m "feat(ui): shared issues filter menu with label and milestone dropdowns"
```

---

### Task 7: Board integration — shared filter in `useReferenceBrowser` and `ReferenceFilterMenu`

**Files:**
- Modify: `packages/ui/src/components/references/useReferenceBrowser.ts:47-48,97,132,250-255,316-326` (carry `labelNames`/`milestoneNames` in the repository filter)
- Modify: `packages/ui/src/components/references/referenceSources.ts:303-331` (`useRepositoryReferenceList` threads the two names into the list-backed read and its cache key)
- Modify: `packages/ui/src/components/references/listBackedReferences.ts:136-166` (pass the two names to `issuesList` for `kind === 'issue'`)
- Modify: `packages/ui/src/components/references/ReferenceBrowser.tsx:71-152` (`ReferenceFilterMenu` renders `IssueFilterMenu` for the repository source when gated)
- Test: `packages/ui/src/components/references/useReferenceBrowser.test.ts` (extend the existing filter test) and `packages/ui/src/components/references/ReferenceBrowser.test.tsx` (if it exists)

**Interfaces:**
- Consumes: `IssueFilter` / `DEFAULT_ISSUE_FILTER` (Task 5), `IssueFilterMenu` (Task 6), `useChoiceOptions` (Task 5), `SourceControlAPI.referenceLabels` / `referenceMilestones` (Task 4), `descriptor.features.labels` / `descriptor.features.milestones` (Task 4).
- Produces: the board's repository filter carries `labelNames` and `milestoneNames`; the board's filter menu shows the two dropdowns on a host that publishes both; `fetchListBackedReferencePage` sends `label`/`milestone` only for `kind === 'issue'`.

- [x] **Step 1: Extend the repository filter state in `useReferenceBrowser`**

In `packages/ui/src/components/references/useReferenceBrowser.ts`:

(a) The remembered filter map (line 48) is typed `RepositoryReferenceFilter`. The repository filter used by the list must carry the two name arrays. Introduce the wider shape locally without changing `RepositoryReferenceFilter` (which the API and other surfaces use):

```ts
import { DEFAULT_ISSUE_FILTER, type IssueFilter } from './referencePickerItems';

type RepositoryListFilter = IssueFilter;
const lastRepositoryFilter = new Map<RepositoryReferenceKind, RepositoryListFilter>();
```

Update `chosenRepositoryFilter` state (line 97) and `repositoryFilter` (line 132) to `RepositoryListFilter`, defaulting to `DEFAULT_ISSUE_FILTER`.

(b) `selectRepositoryFilter` (line 250) already merges a `Partial` patch; widen its parameter to `Partial<RepositoryListFilter>` so the dropdowns can set `labelNames`/`milestoneNames`.

(c) Expose the two gating flags and the option states on the returned object (lines 303-347):

```ts
        features: { labels: descriptor.features.labels, milestones: descriptor.features.milestones },
```

The option reads (`useChoiceOptions` for labels and milestones) are owned by the surface that renders the menu (the board view), not the browser hook, so the hook only exposes `features` and the filter.

- [x] **Step 2: Pass the names through the list read**

In `packages/ui/src/components/references/listBackedReferences.ts`, `fetchListBackedReferencePage` (line 136) takes `filter: RepositoryReferenceFilter`. Widen it to accept the two name arrays and forward them only for issues:

```ts
export const fetchListBackedReferencePage = async (
    reads: ListBackedReads,
    context: SourceControlReadContext,
    provider: ListBackedProvider,
    kind: RepositoryReferenceKind,
    filter: RepositoryReferenceFilter & { labelNames?: string[]; milestoneNames?: string[] },
    text: string,
    cursor: string | null,
): Promise<ListPage<RepositoryReference>> => {
    ...
    const options = {
        page, state: filter.state, people: filter.people, query: text,
        ...(kind === 'issue' ? {
            label: filter.labelNames?.[0],
            milestone: filter.milestoneNames?.[0],
        } : {}),
    };
    ...
};
```

The zero-or-one arrays pass their sole entry; an empty array sends nothing (the adapter omits empty params). Pull requests and discussions send no filter params, so the board's PR tab keeps its current filters.

The list hook `useRepositoryReferenceList` (`packages/ui/src/components/references/referenceSources.ts`, line 303) is where the names must actually reach the read — both the board (through `useReferenceBrowser`) and the panel tab (Task 8) call it, so the threading lives here once. Three edits:

(a) Widen the `filter` option (line 307) so the name arrays are accepted, and destructure the two names (line 312):

```ts
export function useRepositoryReferenceList(options: {
    enabled: boolean;
    directory: string | null;
    kind: RepositoryReferenceKind;
    /** The board's and the Issues panel's filter carries the two name arrays; a bare `{ state, people }` reads as none. */
    filter: RepositoryReferenceFilter & { labelNames?: string[]; milestoneNames?: string[] };
    query: string;
}) {
    const { sourceControl } = useRuntimeAPIs();
    const { enabled, directory, kind, filter, query } = options;
    const { state, people } = filter;
    const label = kind === 'issue' ? filter.labelNames?.[0] : undefined;
    const milestone = kind === 'issue' ? filter.milestoneNames?.[0] : undefined;
```

(b) Forward them into the list-backed read (line 325) — the one Gitea and Forgejo use. The `referenceSearch` branch (line 327) is left as is: it is the picker's generic search, a contract that carries no `label`/`milestone`, and only hosts that publish both features (Gitea/Forgejo, list-backed) reach the widened branch:

```ts
        if (!descriptor.features.referenceSearch) {
            return fetchListBackedReferencePage(sourceControl, readable, { descriptor, urls }, kind, { state, people, label, milestone }, text, cursor);
        }
```

(c) Fold the two names into the cache key (line 320) so a filter change lists again:

```ts
    const key = enabled && directory && context
        ? JSON.stringify([getRuntimeKey(), scope, directory, kind, filter.state, filter.people, label, milestone, text])
        : null;
```

- [x] **Step 3: Render the shared menu in `ReferenceFilterMenu`**

In `packages/ui/src/components/references/ReferenceBrowser.tsx`, `ReferenceFilterMenu` (line 71) currently renders the state/people groups inline for the repository source. Replace that branch with the shared `IssueFilterMenu` when the host offers the extras, keeping the existing inline groups as the fallback for hosts that do not:

```tsx
    const showExtras = repository && source === 'repository' && browser.repositoryKind === 'issue'
        && browser.features?.labels && browser.features?.milestones;
    ...
    return (
        <DropdownMenu>
            ...
            <DropdownMenuContent align="end" className="w-56">
                {showExtras ? (
                    // The shared menu renders its own trigger-less groups; the
                    // outer trigger is reused, so render the content groups here.
                    <IssueFilterGroups
                        filter={repository}
                        onFilterChange={(patch) => browser.selectRepositoryFilter(patch)}
                        labels={browser.labelOptions}
                        milestones={browser.milestoneOptions}
                        showLabel={Boolean(browser.features?.labels)}
                        showMilestone={Boolean(browser.features?.milestones)}
                    />
                ) : source === 'repository' ? (
                    <>
                        {group(...existing state...)}
                        <DropdownMenuSeparator />
                        {group(...existing people...)}
                    </>
                ) : (
                    ...existing tracker branch...
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
```

Because `IssueFilterMenu` (Task 6) owns its own `DropdownMenu` trigger, the cleanest integration is to export a content-only variant from `IssueFilterMenu.tsx`: add `IssueFilterGroups: React.FC` (the same groups/dropdowns, no `DropdownMenu` wrapper) and have `IssueFilterMenu` compose it under its trigger. `ReferenceFilterMenu` then renders `IssueFilterGroups` inside its existing trigger/content, so the board's filter button and summary are unchanged and only the content gains the two dropdowns.

Add to `IssueFilterMenu.tsx` (Task 6's file):

```tsx
export const IssueFilterGroups: React.FC<Omit<IssueFilterMenuProps, 'isMobile'>> = ({ filter, onFilterChange, labels, milestones, showLabel, showMilestone }) => (
  <>
    {/* the state group, people group, and the two nameDropdown calls, exactly as IssueFilterMenu renders them */}
  </>
);
```

and have `IssueFilterMenu` render `<DropdownMenuContent ...><IssueFilterGroups {...props} /></DropdownMenuContent>`.

The board view (`SourceBoardView.tsx`) supplies `browser.labelOptions` / `browser.milestoneOptions` from `useChoiceOptions` keyed by the board's project, reading `referenceLabels` / `referenceMilestones` with the board's read context. Add those two `useChoiceOptions` calls in `SourceBoardView.tsx` where the browser is created and thread them onto the `browser` object the menu reads (a small addition to the object the view passes, not a change to the hook's contract).

- [x] **Step 4: Write the tests**

In `packages/ui/src/components/references/useReferenceBrowser.test.ts`, add a test that the repository filter defaults carry empty name arrays and that `selectRepositoryFilter({ labelNames: ['bug'] })` updates them. In a `ReferenceBrowser.test.tsx` (create if absent), render the filter menu for a repository source on a descriptor with `features.labels` and `features.milestones` true and assert the two dropdown labels render; on a descriptor with them false, assert the dropdowns are absent and the state/people groups remain.

- [x] **Step 5: Run the tests**

Run: `cd packages/ui && bun test src/components/references/useReferenceBrowser.test.ts src/components/references/ReferenceBrowser.test.tsx`
Expected: PASS.

- [x] **Step 6: Commit**

Run: `bun run check:changed` (from the root) — expected PASS.

```bash
git add packages/ui/src/components/references/useReferenceBrowser.ts packages/ui/src/components/references/referenceSources.ts packages/ui/src/components/references/listBackedReferences.ts packages/ui/src/components/references/ReferenceBrowser.tsx packages/ui/src/components/references/IssueFilterMenu.tsx packages/ui/src/components/sourceBoard/SourceBoardView.tsx packages/ui/src/components/references/useReferenceBrowser.test.ts packages/ui/src/components/references/ReferenceBrowser.test.tsx
git commit -m "feat(ui): board issues filter gains the shared label and milestone dropdowns"
```

---

### Task 8: Issues tab in the knowledge panel

**Files:**
- Create: `packages/ui/src/stores/useIssuesPanelStore.ts` (per-project filter + open item persistence)
- Create: `packages/ui/src/components/session/project-context/IssuesSection.tsx` (rows, detail, actions)
- Modify: `packages/ui/src/components/session/project-context/ProjectNotesTodoPanel.tsx:47-49,163-174,369-382,534-584` (add the `issues` tab, gating, split/narrow render)
- Test: `packages/ui/src/components/session/project-context/ProjectNotesTodoPanel.test.tsx` (extend) and `packages/ui/src/components/session/project-context/IssuesSection.test.tsx`

**Interfaces:**
- Consumes: `IssueFilter` / `DEFAULT_ISSUE_FILTER` (Task 5), `IssueFilterMenu` (Task 6), `useChoiceOptions` (Task 5), `SourceControlAPI.issuesList` / `issueGet` / `issueComments` / `referenceLabels` / `referenceMilestones` (Task 4), `useRepositoryReadContext` / `useRepositoryReferenceProvider` from `./referenceSources.ts` (line 219/237), `useSourceControlProvider` from `@/lib/source-control/providers/registry` (line 167), `resolveComposerReferences` from `../references/resolveComposerReferences.ts`, `usePendingComposerReferences` from `../chat/composer/pendingComposerReferences.ts`, `KnowledgeSplit` / `KnowledgeEntryView` / `KnowledgeBackButton` from this folder.
- Produces:
  - `ProjectContextTab` gains `'issues'`; the tab renders only when the project's connected provider publishes both `features.labels` and `features.milestones` and a read context exists.
  - `useIssuesPanelStore`: a zustand persist store keyed by `projectContextId` holding `{ filter: IssueFilter; openIssueNumber: number | null }` per project, so the tab reopens filtered the way it was left.
  - `IssuesSection: React.FC<IssuesSectionProps>` rendering the filtered issue list (rows: number, title, state dot, milestone chip), the in-place detail (full Markdown body, full comment thread, milestone, labels, state, author), and the two actions ("Attach to this session", "Open on {provider}").

- [x] **Step 1: Create the persistence store**

Create `packages/ui/src/stores/useIssuesPanelStore.ts`, modelled on `useSourceBoardStore.ts`:

```ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { DEFAULT_ISSUE_FILTER, type IssueFilter } from '@/components/references/referencePickerItems';

const ISSUES_PANEL_STORAGE_KEY = 'openchamber.issues-panel';

type IssuesPanelEntry = {
  filter: IssueFilter;
  openIssueNumber: number | null;
};

const EMPTY_ENTRY: IssuesPanelEntry = { filter: DEFAULT_ISSUE_FILTER, openIssueNumber: null };

const persistedEntry = z.object({
  filter: z.object({
    state: z.string().catch('open'),
    people: z.string().catch('any'),
    labelNames: z.array(z.string()).catch([]),
    milestoneNames: z.array(z.string()).catch([]),
  }).catch({ ...DEFAULT_ISSUE_FILTER }),
  openIssueNumber: z.number().int().nullable().catch(null),
});

type IssuesPanelState = {
  /** Keyed by runtime, then by project context id. */
  byProject: Record<string, Record<string, IssuesPanelEntry>>;
  getEntry: (projectContextId: string) => IssuesPanelEntry;
  setFilter: (projectContextId: string, filter: IssueFilter) => void;
  setOpenIssue: (projectContextId: string, number: number | null) => void;
};

export const useIssuesPanelStore = create<IssuesPanelState>()(
  persist(
    (set, get) => ({
      byProject: {},
      getEntry: (projectContextId) => {
        const runtimeKey = getRuntimeKey();
        return get().byProject[runtimeKey]?.[projectContextId] ?? EMPTY_ENTRY;
      },
      setFilter: (projectContextId, filter) => set((state) => {
        const runtimeKey = getRuntimeKey();
        const byRuntime = state.byProject[runtimeKey] ?? {};
        return { byProject: { ...state.byProject, [runtimeKey]: { ...byRuntime, [projectContextId]: { ...byRuntime[projectContextId], filter } } } };
      }),
      setOpenIssue: (projectContextId, number) => set((state) => {
        const runtimeKey = getRuntimeKey();
        const byRuntime = state.byProject[runtimeKey] ?? {};
        return { byProject: { ...state.byProject, [runtimeKey]: { ...byRuntime, [projectContextId]: { ...byRuntime[projectContextId], openIssueNumber: number } } } };
      }),
    }),
    {
      name: ISSUES_PANEL_STORAGE_KEY,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({ byProject: state.byProject }),
      merge: (persisted, current) => {
        const parsed = z.object({ byProject: z.record(z.string(), z.record(z.string(), persistedEntry)).catch({}) }).safeParse(persisted);
        return parsed.success ? { ...current, byProject: parsed.data.byProject } : { ...current, byProject: {} };
      },
    },
  ),
);
```

- [x] **Step 2: Create the `IssuesSection` component**

Create `packages/ui/src/components/session/project-context/IssuesSection.tsx`. It owns the list read (through `useRepositoryReferenceList` from `../references/referenceSources.ts` with `kind: 'issue'` and the persisted `IssueFilter`), the option reads (`useChoiceOptions` for labels and milestones), the detail read (`issueGet` + `issueComments`), and the two actions.

```tsx
import * as React from 'react';

import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import type { Issue, IssueComment, Label, MilestoneChoice, RepositorySelector } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';

import { IssueFilterMenu } from '../../references/IssueFilterMenu';
import { useChoiceOptions } from '../../references/issueFilterOptions';
import { useRepositoryReadContext, useRepositoryReferenceList, useRepositoryReferenceProvider } from '../../references/referenceSources';
import { DEFAULT_ISSUE_FILTER, type IssueFilter } from '../../references/referencePickerItems';
import { resolveComposerReferences } from '../../references/resolveComposerReferences';
import { usePendingComposerReferences } from '../../chat/composer/pendingComposerReferences';
import { toast } from '@/components/ui';

export type IssuesSectionProps = {
  directory: string;
  filter: IssueFilter;
  onFilterChange: (patch: Partial<IssueFilter>) => void;
  openIssueNumber: number | null;
  onOpenIssue: (number: number | null) => void;
  split: boolean;
};

/** The project's issues, filtered, with the full issue opened in place. */
export const IssuesSection: React.FC<IssuesSectionProps> = ({ directory, filter, onFilterChange, openIssueNumber, onOpenIssue, split }) => {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const readContext = useRepositoryReadContext(directory);
  const providerId = useRepositoryReferenceProvider(directory);
  const descriptor = useSourceControlProvider(providerId);

  const context = readContext && readContext !== 'missing' ? readContext : null;

  const list = useRepositoryReferenceList({
    enabled: context !== null,
    directory,
    kind: 'issue',
    filter,
    query: '',
  });

  // The project selector (owner/repo) names the repository the option and
  // detail reads come from. The read context carries no owner/repo, so the
  // board's own source answers: the first listed issue's `sourceRepo`, the way
  // SourceBoardMetaEditors.tsx derives its selector. It is the repository, not
  // the items, so it is stable across filters — the last known value is kept
  // when a filtered page comes back empty.
  const [project, setProject] = React.useState<RepositorySelector | null>(null);
  React.useEffect(() => {
    const first = list.items[0]?.sourceRepo;
    if (!first) return;
    setProject((current) => (current && current.owner === first.owner && current.repo === first.repo ? current : { owner: first.owner, repo: first.repo }));
  }, [list.items]);

  const labels = useChoiceOptions<Label>(
    React.useCallback(async () => (context && project ? sourceControl.referenceLabels(context, project) : []), [context, project, sourceControl]),
    context && project ? `${context.provider}:${context.directory}:labels` : null,
  );
  const milestones = useChoiceOptions<MilestoneChoice>(
    React.useCallback(async () => (context && project ? sourceControl.referenceMilestones(context, project) : []), [context, project, sourceControl]),
    context && project ? `${context.provider}:${context.directory}:milestones` : null,
  );

  const openIssue = openIssueNumber !== null && context ? React.useMemo(() => {
    let cancelled = false;
    const load = async () => {
      const [issue, comments] = await Promise.all([
        sourceControl.issueGet(context, openIssueNumber, project ?? undefined),
        sourceControl.issueComments(context, openIssueNumber, project ?? undefined),
      ]);
      if (!cancelled) return { issue, comments };
    };
    return load();
  }, [context, openIssueNumber, project, sourceControl]) : null;

  const attachToSession = (issue: Issue) => {
    if (!context) return;
    void resolveComposerReferences([{ source: 'repository', reference: { kind: 'issue', provider: issue.provider, number: issue.number, title: issue.title, url: issue.url, body: issue.body ?? '', bodyTruncated: false, createdAt: issue.createdAt ?? null, updatedAt: issue.updatedAt ?? null, author: null, labels: [], commentCount: 0, sourceRepo: { owner: issue.project.owner, repo: issue.project.name, source: 'origin' } } as any, includeDiff: false }], {
      sourceControl,
      context,
      readTrackerDetail: () => Promise.reject(new Error('n/a')),
      trackerName: () => '',
    }).then(({ references, failures }) => {
      if (references.length > 0) usePendingComposerReferences.getState().push(references);
      if (failures[0]) toast.error(t('issuesPanel.error.listFailed'), { description: failures[0].error });
    });
  };

  const openOnHost = (issue: Issue) => {
    // The host's own page for the issue; the app's normal link handling opens it.
    window.open(issue.url, '_blank', 'noopener,noreferrer');
  };

  if (!context) {
    return <p className="typography-meta text-muted-foreground">{t('issuesPanel.empty')}</p>;
  }

  const rows = list.items;
  const openDetail = openIssue?.issue ?? null;

  const detail = openDetail ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <IssueDetail issue={openDetail} comments={openIssue?.comments ?? []} descriptorLabel={descriptor.label} onAttach={() => attachToSession(openDetail)} onOpenOnHost={() => openOnHost(openDetail)} t={t} />
      </div>
    </div>
  ) : null;

  if (split) {
    return (
      <div className="flex h-full min-h-0">
        <div className="h-full w-[380px] flex-shrink-0 overflow-y-auto border-e border-border/60 p-3"><IssuesList rows={rows} openIssueNumber={openIssueNumber} onOpenIssue={onOpenIssue} filter={filter} onFilterChange={onFilterChange} labels={labels} milestones={milestones} showLabel={descriptor.features.labels} showMilestone={descriptor.features.milestones} t={t} /></div>
        <div className="h-full min-w-0 flex-1 overflow-hidden p-3">{detail ?? <div className="flex h-full items-center justify-center px-6 text-center typography-meta text-muted-foreground">{t('issuesPanel.empty')}</div>}</div>
      </div>
    );
  }
  return openIssueNumber !== null && detail ? detail : <IssuesList rows={rows} openIssueNumber={openIssueNumber} onOpenIssue={onOpenIssue} filter={filter} onFilterChange={onFilterChange} labels={labels} milestones={milestones} showLabel={descriptor.features.labels} showMilestone={descriptor.features.milestones} t={t} />;
};
```

`IssuesList` and `IssueDetail` are private components in the same file: `IssuesList` renders the filter menu (`IssueFilterMenu`), the loading/failure/empty states (a failed list read shows the failure state, never an empty list), and the rows (number, title, state dot, milestone chip); `IssueDetail` renders the full Markdown body, the full comment thread, milestone, labels, state and author, and the two action buttons. `useRepositoryReferenceList` accepts the `IssueFilter` directly (Task 7 widened its `filter` parameter to carry the two name arrays), so the list read needs no cast. The single `as any` on the resolved reference is intentional: it builds a `RepositoryIssueReference` from the `Issue` detail DTO, whose `project: { owner, name }` shape is not the list row's `sourceRepo: { owner, repo }`.

- [x] **Step 3: Wire the tab into `ProjectNotesTodoPanel`**

In `packages/ui/src/components/session/project-context/ProjectNotesTodoPanel.tsx`:

(a) Extend the tab type and order (lines 47-49):

```ts
type ProjectContextTab = 'notes' | 'todos' | 'plans' | 'memory' | 'issues';
const TAB_ORDER: ProjectContextTab[] = ['notes', 'todos', 'plans', 'memory', 'issues'];
```

(b) Gate the tab. Add a memo that is true only when the project's connected provider publishes both features and a read context exists:

```ts
  const repositoryProvider = useRepositoryReferenceProvider(projectRef?.path ?? null);
  const repositoryDescriptor = useSourceControlProvider(repositoryProvider);
  const issuesVisible = Boolean(
    projectRef && repositoryDescriptor.features.labels && repositoryDescriptor.features.milestones,
  );
```

(c) Add the tab to `sections` (lines 369-382), after the memory entry, gated on `issuesVisible` (count `0`; the issues list is server-backed and not counted in the panel's search):

```ts
    ...(issuesVisible ? [{
      id: 'issues' as const,
      icon: 'task' as IconName,
      label: t('issuesPanel.tab.label'),
      count: 0,
      unseen: 0,
    }] : []),
```

(d) Persist the filter and open item per project via `useIssuesPanelStore`:

```ts
  const issuesEntry = useIssuesPanelStore((state) => (projectContextId ? state.byProject[getRuntimeKey()]?.[projectContextId] : undefined) ?? EMPTY_ISSUES_ENTRY);
  const setIssuesFilter = useIssuesPanelStore((state) => state.setFilter);
  const setIssuesOpen = useIssuesPanelStore((state) => state.setOpenIssue);
```

(e) Render the section (lines 534-584), adding an `issues` branch that uses `KnowledgeSplit` when `split` and `IssuesSection` with a back button when narrow:

```tsx
        {activeTab === 'issues' && issuesVisible ? (
          split ? (
            <KnowledgeSplit
              list={<IssuesSection directory={projectRef.path} filter={issuesEntry.filter} onFilterChange={(patch) => setIssuesFilter(projectContextId, { ...issuesEntry.filter, ...patch })} openIssueNumber={openIdIn('issues')} onOpenIssue={(n) => setIssuesOpen(projectContextId, n)} split />}
              detail={openIdIn('issues') ? <IssuesSection directory={projectRef.path} filter={issuesEntry.filter} onFilterChange={() => undefined} openIssueNumber={openIdIn('issues')} onOpenIssue={setIssuesOpenBound} split={false} /> : null}
              emptyLabel={t('issuesPanel.empty')}
            />
          ) : (
            <IssuesSection directory={projectRef.path} filter={issuesEntry.filter} onFilterChange={(patch) => setIssuesFilter(projectContextId, { ...issuesEntry.filter, ...patch })} openIssueNumber={openIdIn('issues')} onOpenIssue={(n) => setIssuesOpen(projectContextId, n)} split={false} />
          )
        ) : null}
```

(Adapt the exact prop threading to how `KnowledgeSplit` takes `list`/`detail`; the narrow case shows the detail in place with a `KnowledgeBackButton`, mirroring the plans branch at lines 576-584.)

- [x] **Step 4: Write the tests**

In `ProjectNotesTodoPanel.test.tsx`, add:
- a gating test: a project whose provider descriptor has `features.labels` true and `features.milestones` false renders no Issues tab (and the reverse); both true renders the tab. (This pins Review Focus line 5.)
- a persistence test: setting the filter and an open issue for a project, then re-reading the store, returns the same filter and open issue.

In `IssuesSection.test.tsx`:
- a list-failure test: with the list read failing, the section shows the failure state, not an empty list. (This pins Review Focus line 4.)
- a detail test: opening an issue renders its body, a comment, the milestone and a label.
- an attach test: "Attach to this session" pushes a `repository-issue` composer reference.

- [x] **Step 5: Run the tests**

Run: `cd packages/ui && bun test src/components/session/project-context/ProjectNotesTodoPanel.test.tsx src/components/session/project-context/IssuesSection.test.tsx`
Expected: PASS.

- [x] **Step 6: Commit**

Run: `bun run check:changed` (from the root) — expected PASS.

```bash
git add packages/ui/src/stores/useIssuesPanelStore.ts packages/ui/src/components/session/project-context/IssuesSection.tsx packages/ui/src/components/session/project-context/ProjectNotesTodoPanel.tsx packages/ui/src/components/session/project-context/ProjectNotesTodoPanel.test.tsx packages/ui/src/components/session/project-context/IssuesSection.test.tsx
git commit -m "feat(ui): issues tab in the project knowledge panel"
```

---

### Task 9: i18n — `issuesPanel` fragment in all 15 locales

**Files:**
- Create: `packages/ui/src/lib/i18n/messages/issues-panel.i18n.ts`
- Modify: all 15 locale dictionaries — `packages/ui/src/lib/i18n/messages/{en,de,fr,nl,es,ja,pt-BR,uk,ko,pl,zh-CN,zh-TW,tr,ar,he}.ts` (import the fragment and spread it into each `dict`)
- Test: `packages/ui/src/lib/i18n/messages.test.ts` (key parity already covers it; add one assertion that the tab label is translated)

**Interfaces:**
- Consumes: nothing.
- Produces: the `issuesPanel.*` keys used by Tasks 6 and 8, present in every locale with the same key set as `en` (the parity test enforces this).

The 15 keys:

| Key | en |
| --- | --- |
| `issuesPanel.tab.label` | Issues |
| `issuesPanel.filter.milestone` | Milestone |
| `issuesPanel.filter.label` | Label |
| `issuesPanel.filter.allLabels` | All labels |
| `issuesPanel.filter.allMilestones` | All milestones |
| `issuesPanel.filter.stale` | Showing the last list read |
| `issuesPanel.filter.unavailable` | Could not read the {what} list |
| `issuesPanel.empty` | No issues match the filter |
| `issuesPanel.detail.milestone` | Milestone |
| `issuesPanel.detail.state.open` | Open |
| `issuesPanel.detail.state.closed` | Closed |
| `issuesPanel.detail.author` | Author |
| `issuesPanel.actions.attach` | Attach to this session |
| `issuesPanel.actions.openOnHost` | Open on {provider} |
| `issuesPanel.back` | Back to issues |

- [x] **Step 1: Create the fragment**

Create `packages/ui/src/lib/i18n/messages/issues-panel.i18n.ts`:

```ts
/** The Issues tab in the project knowledge panel and the shared issues filter. Merged into each locale's main dictionary. */
export const issuesPanelI18n = {
  en: {
    'issuesPanel.tab.label': 'Issues',
    'issuesPanel.filter.milestone': 'Milestone',
    'issuesPanel.filter.label': 'Label',
    'issuesPanel.filter.all': 'All',
    'issuesPanel.filter.stale': 'Showing the last list read',
    'issuesPanel.filter.unavailable': 'Could not read the {what} list',
    'issuesPanel.empty': 'No issues match the filter',
    'issuesPanel.detail.milestone': 'Milestone',
    'issuesPanel.detail.labels': 'Labels',
    'issuesPanel.detail.state.open': 'Open',
    'issuesPanel.detail.state.closed': 'Closed',
    'issuesPanel.detail.author': 'Author',
    'issuesPanel.actions.attach': 'Attach to this session',
    'issuesPanel.actions.openOnHost': 'Open on {provider}',
    'issuesPanel.error.listFailed': 'Could not read the issue list',
    'issuesPanel.back': 'Back to issues',
  },
  de: {
    'issuesPanel.tab.label': 'Probleme',
    'issuesPanel.filter.milestone': 'Meilenstein',
    'issuesPanel.filter.label': 'Label',
    'issuesPanel.filter.all': 'Alle',
    'issuesPanel.filter.stale': 'Zeigt die zuletzt gelesene Liste',
    'issuesPanel.filter.unavailable': 'Die {what}-Liste konnte nicht gelesen werden',
    'issuesPanel.empty': 'Keine Probleme entsprechen dem Filter',
    'issuesPanel.detail.milestone': 'Meilenstein',
    'issuesPanel.detail.labels': 'Labels',
    'issuesPanel.detail.state.open': 'Offen',
    'issuesPanel.detail.state.closed': 'Geschlossen',
    'issuesPanel.detail.author': 'Autor',
    'issuesPanel.actions.attach': 'An diese Sitzung anfügen',
    'issuesPanel.actions.openOnHost': 'In {provider} öffnen',
    'issuesPanel.error.listFailed': 'Die Problemliste konnte nicht gelesen werden',
    'issuesPanel.back': 'Zurück zu den Problemen',
  },
  fr: {
    'issuesPanel.tab.label': 'Problèmes',
    'issuesPanel.filter.milestone': 'Jalon',
    'issuesPanel.filter.label': 'Étiquette',
    'issuesPanel.filter.all': 'Tous',
    'issuesPanel.filter.stale': 'Affiche la dernière liste lue',
    'issuesPanel.filter.unavailable': 'Impossible de lire la liste des {what}',
    'issuesPanel.empty': 'Aucun problème ne correspond au filtre',
    'issuesPanel.detail.milestone': 'Jalon',
    'issuesPanel.detail.labels': 'Étiquettes',
    'issuesPanel.detail.state.open': 'Ouvert',
    'issuesPanel.detail.state.closed': 'Fermé',
    'issuesPanel.detail.author': 'Auteur',
    'issuesPanel.actions.attach': 'Attacher à cette session',
    'issuesPanel.actions.openOnHost': 'Ouvrir dans {provider}',
    'issuesPanel.error.listFailed': 'Impossible de lire la liste des problèmes',
    'issuesPanel.back': 'Retour aux problèmes',
  },
  nl: {
    'issuesPanel.tab.label': 'Problemen',
    'issuesPanel.filter.milestone': 'Mijlpaal',
    'issuesPanel.filter.label': 'Label',
    'issuesPanel.filter.all': 'Alle',
    'issuesPanel.filter.stale': 'Toont de laatst gelezen lijst',
    'issuesPanel.filter.unavailable': 'De {what}-lijst kon niet worden gelezen',
    'issuesPanel.empty': 'Geen problemen komen overeen met de filter',
    'issuesPanel.detail.milestone': 'Mijlpaal',
    'issuesPanel.detail.labels': 'Labels',
    'issuesPanel.detail.state.open': 'Open',
    'issuesPanel.detail.state.closed': 'Gesloten',
    'issuesPanel.detail.author': 'Auteur',
    'issuesPanel.actions.attach': 'Toevoegen aan deze sessie',
    'issuesPanel.actions.openOnHost': 'Openen in {provider}',
    'issuesPanel.error.listFailed': 'De probleemlijst kon niet worden gelezen',
    'issuesPanel.back': 'Terug naar problemen',
  },
  es: {
    'issuesPanel.tab.label': 'Problemas',
    'issuesPanel.filter.milestone': 'Hito',
    'issuesPanel.filter.label': 'Etiqueta',
    'issuesPanel.filter.all': 'Todos',
    'issuesPanel.filter.stale': 'Mostrando la última lista leída',
    'issuesPanel.filter.unavailable': 'No se pudo leer la lista de {what}',
    'issuesPanel.empty': 'Ningún problema coincide con el filtro',
    'issuesPanel.detail.milestone': 'Hito',
    'issuesPanel.detail.labels': 'Etiquetas',
    'issuesPanel.detail.state.open': 'Abierto',
    'issuesPanel.detail.state.closed': 'Cerrado',
    'issuesPanel.detail.author': 'Autor',
    'issuesPanel.actions.attach': 'Adjuntar a esta sesión',
    'issuesPanel.actions.openOnHost': 'Abrir en {provider}',
    'issuesPanel.error.listFailed': 'No se pudo leer la lista de problemas',
    'issuesPanel.back': 'Volver a los problemas',
  },
  ja: {
    'issuesPanel.tab.label': '問題',
    'issuesPanel.filter.milestone': 'マイルストーン',
    'issuesPanel.filter.label': 'ラベル',
    'issuesPanel.filter.all': 'すべて',
    'issuesPanel.filter.stale': '最後に読んだリストを表示中',
    'issuesPanel.filter.unavailable': '{what}のリストを読み取れませんでした',
    'issuesPanel.empty': 'フィルターに一致する問題はありません',
    'issuesPanel.detail.milestone': 'マイルストーン',
    'issuesPanel.detail.labels': 'ラベル',
    'issuesPanel.detail.state.open': 'オープン',
    'issuesPanel.detail.state.closed': 'クローズ',
    'issuesPanel.detail.author': '作成者',
    'issuesPanel.actions.attach': 'このセッションに添付',
    'issuesPanel.actions.openOnHost': '{provider}で開く',
    'issuesPanel.error.listFailed': '問題のリストを読み取れませんでした',
    'issuesPanel.back': '問題列表に戻る',
  },
  'pt-BR': {
    'issuesPanel.tab.label': 'Problemas',
    'issuesPanel.filter.milestone': 'Marco',
    'issuesPanel.filter.label': 'Etiqueta',
    'issuesPanel.filter.all': 'Todos',
    'issuesPanel.filter.stale': 'Mostrando a última lista lida',
    'issuesPanel.filter.unavailable': 'Não foi possível ler a lista de {what}',
    'issuesPanel.empty': 'Nenhum problema corresponde ao filtro',
    'issuesPanel.detail.milestone': 'Marco',
    'issuesPanel.detail.labels': 'Etiquetas',
    'issuesPanel.detail.state.open': 'Aberto',
    'issuesPanel.detail.state.closed': 'Fechado',
    'issuesPanel.detail.author': 'Autor',
    'issuesPanel.actions.attach': 'Anexar a esta sessão',
    'issuesPanel.actions.openOnHost': 'Abrir no {provider}',
    'issuesPanel.error.listFailed': 'Não foi possível ler a lista de problemas',
    'issuesPanel.back': 'Voltar aos problemas',
  },
  uk: {
    'issuesPanel.tab.label': 'Проблеми',
    'issuesPanel.filter.milestone': 'Вехи',
    'issuesPanel.filter.label': 'Мітка',
    'issuesPanel.filter.all': 'Усі',
    'issuesPanel.filter.stale': 'Показано останньо прочитаний список',
    'issuesPanel.filter.unavailable': 'Не вдалося прочитати список {what}',
    'issuesPanel.empty': 'Немає проблем, що відповідають фільтру',
    'issuesPanel.detail.milestone': 'Вехи',
    'issuesPanel.detail.labels': 'Мітки',
    'issuesPanel.detail.state.open': 'Відкрито',
    'issuesPanel.detail.state.closed': 'Закрито',
    'issuesPanel.detail.author': 'Автор',
    'issuesPanel.actions.attach': 'Прикріпити до цієї сесії',
    'issuesPanel.actions.openOnHost': 'Відкрити в {provider}',
    'issuesPanel.error.listFailed': 'Не вдалося прочитати список проблем',
    'issuesPanel.back': 'Назад до проблем',
  },
  ko: {
    'issuesPanel.tab.label': '이슈',
    'issuesPanel.filter.milestone': '마일스톤',
    'issuesPanel.filter.label': '라벨',
    'issuesPanel.filter.all': '전체',
    'issuesPanel.filter.stale': '마지막으로 읽은 목록 표시 중',
    'issuesPanel.filter.unavailable': '{what} 목록을 읽을 수 없습니다',
    'issuesPanel.empty': '필터에 일치하는 이슈가 없습니다',
    'issuesPanel.detail.milestone': '마일스톤',
    'issuesPanel.detail.labels': '라벨',
    'issuesPanel.detail.state.open': '열림',
    'issuesPanel.detail.state.closed': '닫힘',
    'issuesPanel.detail.author': '작성자',
    'issuesPanel.actions.attach': '이 세션에 첨부',
    'issuesPanel.actions.openOnHost': '{provider}에서 열기',
    'issuesPanel.error.listFailed': '이슈 목록을 읽을 수 없습니다',
    'issuesPanel.back': '이슈 목록으로 돌아가기',
  },
  pl: {
    'issuesPanel.tab.label': 'Zgłoszenia',
    'issuesPanel.filter.milestone': 'Kamień milowy',
    'issuesPanel.filter.label': 'Etykieta',
    'issuesPanel.filter.all': 'Wszystkie',
    'issuesPanel.filter.stale': 'Wyświetlano ostatnio odczytaną listę',
    'issuesPanel.filter.unavailable': 'Nie udało się odczytać listy {what}',
    'issuesPanel.empty': 'Brak zgłoszeń zgodnych z filtrem',
    'issuesPanel.detail.milestone': 'Kamień milowy',
    'issuesPanel.detail.labels': 'Etykiety',
    'issuesPanel.detail.state.open': 'Otwarte',
    'issuesPanel.detail.state.closed': 'Zamknięte',
    'issuesPanel.detail.author': 'Autor',
    'issuesPanel.actions.attach': 'Dołącz do tej sesji',
    'issuesPanel.actions.openOnHost': 'Otwórz w {provider}',
    'issuesPanel.error.listFailed': 'Nie udało się odczytać listy zgłoszeń',
    'issuesPanel.back': 'Powrót do zgłoszeń',
  },
  'zh-CN': {
    'issuesPanel.tab.label': '议题',
    'issuesPanel.filter.milestone': '里程碑',
    'issuesPanel.filter.label': '标签',
    'issuesPanel.filter.all': '全部',
    'issuesPanel.filter.stale': '显示上次读取的列表',
    'issuesPanel.filter.unavailable': '无法读取{what}列表',
    'issuesPanel.empty': '没有符合筛选条件的议题',
    'issuesPanel.detail.milestone': '里程碑',
    'issuesPanel.detail.labels': '标签',
    'issuesPanel.detail.state.open': '打开',
    'issuesPanel.detail.state.closed': '已关闭',
    'issuesPanel.detail.author': '作者',
    'issuesPanel.actions.attach': '附加到此会话',
    'issuesPanel.actions.openOnHost': '在{provider}中打开',
    'issuesPanel.error.listFailed': '无法读取议题列表',
    'issuesPanel.back': '返回议题',
  },
  'zh-TW': {
    'issuesPanel.tab.label': '議題',
    'issuesPanel.filter.milestone': '里程碑',
    'issuesPanel.filter.label': '標籤',
    'issuesPanel.filter.all': '全部',
    'issuesPanel.filter.stale': '顯示上次讀取的清單',
    'issuesPanel.filter.unavailable': '無法讀取{what}清單',
    'issuesPanel.empty': '沒有符合篩選條件的議題',
    'issuesPanel.detail.milestone': '里程碑',
    'issuesPanel.detail.labels': '標籤',
    'issuesPanel.detail.state.open': '開啟',
    'issuesPanel.detail.state.closed': '已關閉',
    'issuesPanel.detail.author': '作者',
    'issuesPanel.actions.attach': '新增到此工作階段',
    'issuesPanel.actions.openOnHost': '在{provider}中開啟',
    'issuesPanel.error.listFailed': '無法讀取議題清單',
    'issuesPanel.back': '返回議題',
  },
  tr: {
    'issuesPanel.tab.label': 'Sorunlar',
    'issuesPanel.filter.milestone': 'Kilometre taşı',
    'issuesPanel.filter.label': 'Etiket',
    'issuesPanel.filter.all': 'Tümü',
    'issuesPanel.filter.stale': 'Son okunan liste gösteriliyor',
    'issuesPanel.filter.unavailable': '{what} listesi okunamadı',
    'issuesPanel.empty': 'Filtreye uyan sorun yok',
    'issuesPanel.detail.milestone': 'Kilometre taşı',
    'issuesPanel.detail.labels': 'Etiketler',
    'issuesPanel.detail.state.open': 'Açık',
    'issuesPanel.detail.state.closed': 'Kapalı',
    'issuesPanel.detail.author': 'Yazar',
    'issuesPanel.actions.attach': 'Bu oturuma ekle',
    'issuesPanel.actions.openOnHost': '{provider}da aç',
    'issuesPanel.error.listFailed': 'Sorun listesi okunamadı',
    'issuesPanel.back': 'Sorunlara dön',
  },
  ar: {
    'issuesPanel.tab.label': 'المشاكل',
    'issuesPanel.filter.milestone': 'نقطة مرحلية',
    'issuesPanel.filter.label': 'التسمية',
    'issuesPanel.filter.all': 'الكل',
    'issuesPanel.filter.stale': 'عرض آخر قائمة تم قراءتها',
    'issuesPanel.filter.unavailable': 'تعذرت قراءة قائمة {what}',
    'issuesPanel.empty': 'لا توجد مشاكل تطابق المرشح',
    'issuesPanel.detail.milestone': 'نقطة مرحلية',
    'issuesPanel.detail.labels': 'التسميات',
    'issuesPanel.detail.state.open': 'مفتوح',
    'issuesPanel.detail.state.closed': 'مغلق',
    'issuesPanel.detail.author': 'المؤلف',
    'issuesPanel.actions.attach': 'إرفاق بهذه الجلسة',
    'issuesPanel.actions.openOnHost': 'فتح في {provider}',
    'issuesPanel.error.listFailed': 'تعذرت قراءة قائمة المشاكل',
    'issuesPanel.back': 'العودة إلى المشاكل',
  },
  he: {
    'issuesPanel.tab.label': 'בעיות',
    'issuesPanel.filter.milestone': 'אבן דרך',
    'issuesPanel.filter.label': 'תג',
    'issuesPanel.filter.all': 'הכל',
    'issuesPanel.filter.stale': 'מציג את הרשימה האחרונה שנקראה',
    'issuesPanel.filter.unavailable': 'לא ניתן לקרוא את רשימת ה{what}',
    'issuesPanel.empty': 'אין בעיות התואמות את המסנן',
    'issuesPanel.detail.milestone': 'אבן דרך',
    'issuesPanel.detail.labels': 'תגים',
    'issuesPanel.detail.state.open': 'פתוח',
    'issuesPanel.detail.state.closed': 'סגור',
    'issuesPanel.detail.author': 'מחבר',
    'issuesPanel.actions.attach': 'צירוף לסשן זה',
    'issuesPanel.actions.openOnHost': 'פתיחה ב-{provider}',
    'issuesPanel.error.listFailed': 'לא ניתן לקרוא את רשימת הבעיות',
    'issuesPanel.back': 'חזרה לבעיות',
  },
};
```

- [x] **Step 2: Merge the fragment into all 15 locale dictionaries**

In each of the 15 files `packages/ui/src/lib/i18n/messages/{en,de,fr,nl,es,ja,pt-BR,uk,ko,pl,zh-CN,zh-TW,tr,ar,he}.ts`:

(a) Add the import beside the other fragment imports (e.g. in `en.ts` after the `sourceBoardI18n` import at line 24):

```ts
import { issuesPanelI18n } from './issues-panel.i18n';
```

(b) Add the spread inside the `dict` object, beside the other fragment spreads (e.g. in `en.ts` after `...sourceBoardI18n.en,` at line 172):

```ts
  ...issuesPanelI18n.en,
```

Use the matching locale member (`...issuesPanelI18n.de` in `de.ts`, `...issuesPanelI18n['pt-BR']` in `pt-BR.ts`, `...issuesPanelI18n['zh-CN']` in `zh-CN.ts`, etc.).

- [x] **Step 3: Add a parity assertion**

In `packages/ui/src/lib/i18n/messages.test.ts`, inside `describe('i18n dictionaries', ...)`, add:

```ts
  test('the issues tab label is translated in every locale', () => {
    for (const [locale, dictionary] of Object.entries(localeDictionaries)) {
      expect(dictionary['issuesPanel.tab.label']).toBeTruthy();
      if (locale !== 'en') expect(dictionary['issuesPanel.tab.label']).not.toBe(enDict['issuesPanel.tab.label']);
    }
  });
```

- [x] **Step 4: Run the i18n test**

Run: `cd packages/ui && bun test src/lib/i18n/messages.test.ts`
Expected: PASS (key parity across all 15 locales plus the new assertion).

- [x] **Step 5: Commit**

Run: `bun run check:changed` (from the root) — expected PASS.

```bash
git add packages/ui/src/lib/i18n/messages/issues-panel.i18n.ts packages/ui/src/lib/i18n/messages/en.ts packages/ui/src/lib/i18n/messages/de.ts packages/ui/src/lib/i18n/messages/fr.ts packages/ui/src/lib/i18n/messages/nl.ts packages/ui/src/lib/i18n/messages/es.ts packages/ui/src/lib/i18n/messages/ja.ts packages/ui/src/lib/i18n/messages/pt-BR.ts packages/ui/src/lib/i18n/messages/uk.ts packages/ui/src/lib/i18n/messages/ko.ts packages/ui/src/lib/i18n/messages/pl.ts packages/ui/src/lib/i18n/messages/zh-CN.ts packages/ui/src/lib/i18n/messages/zh-TW.ts packages/ui/src/lib/i18n/messages/tr.ts packages/ui/src/lib/i18n/messages/ar.ts packages/ui/src/lib/i18n/messages/he.ts packages/ui/src/lib/i18n/messages.test.ts
git commit -m "feat(ui): issues panel strings in all locales"
```

---

### Task 10: Documentation updates

**Files:**
- Modify: `packages/web/server/lib/source-control/DOCUMENTATION.md` (the `provider-routes.js` bullet and the capability-publication note)
- Modify: `packages/web/server/lib/gitea/DOCUMENTATION.md` (the invariants list and the verified-against-live note)
- Modify: `packages/web/server/lib/forgejo/DOCUMENTATION.md` (a line noting it inherits the milestones capability)
- Modify: `packages/ui/src/components/references/DOCUMENTATION.md` (the new filter model, options hook and shared menu)
- Modify: `packages/ui/src/components/session/project-context/DOCUMENTATION.md` (the new Issues tab)

**Interfaces:**
- Consumes: the behavior implemented in Tasks 1-9.
- Produces: owning-module documentation that names the new reads, the capability, the gate, and the persistence.

- [x] **Step 1: Update the source-control module doc**

In `packages/web/server/lib/source-control/DOCUMENTATION.md`, in the `provider-routes.js` bullet (line 21), add `milestones` to the bound-reads list ("status, lists, context, issues, upstream, branches, labels, reviewers" → "…, labels, reviewers, milestones"). In the capability-publication note near line 135 (the Presentation bullet under *Change-based review hosts*) or the `Repository discussions` section (line 145), add a sentence: `publicProviderDescriptor` publishes `features.labels` and `features.milestones` from the capabilities, each only when the capability is `true`, so a provider that turns one off publishes exactly what it always did.

- [x] **Step 2: Update the Gitea module doc**

In `packages/web/server/lib/gitea/DOCUMENTATION.md`, in the Invariants list, add a bullet after the labels one (line 30): milestones are read as a whole collection (`GET /repos/{o}/{r}/milestones?state=all`) up to the existing collection bound and mapped to `{ name, state }` (the host's `title`/`state`); the issue list takes `label` and `milestone` and forwards them as the host's own query parameters. In the *Verified against live instances* section, add a line noting the milestones read and the two issue-list parameters were verified against live Gitea 1.21.11 and 1.27.3 (or mark them as assumed if not yet exercised live, per the doc's existing "Still unverified" convention).

- [x] **Step 3: Update the Forgejo module doc**

In `packages/web/server/lib/forgejo/DOCUMENTATION.md`, in the Invariants list, add a line: the `milestones` capability and the `label`/`milestone` issue-list parameters are Gitea's by construction (`...giteaDescriptor`), so Forgejo answers `/references/milestones` and the filtered issue list without its own code.

- [x] **Step 4: Update the references module doc**

In `packages/ui/src/components/references/DOCUMENTATION.md`, add entries for the new files and the shared filter: the `IssueFilter` model (`state`, `people`, `labelNames`, `milestoneNames`, each array zero-or-one in this cut), the `useChoiceOptions` hook (last-good-on-stale-failure over the value cache; a first failure disables the dropdown, a refresh failure keeps the last good list with a stale hint, a fetch failure is never an authoritative empty), and the shared `IssueFilterMenu` / `IssueFilterGroups` used by both the board's filter menu and the knowledge panel's Issues tab.

- [x] **Step 5: Update the project-context module doc**

In `packages/ui/src/components/session/project-context/DOCUMENTATION.md`, in the Files table, add rows for `IssuesSection.tsx` and `stores/useIssuesPanelStore.ts`. Add a short section describing the Issues tab: it renders only when the project's connected provider publishes both `features.labels` and `features.milestones` and a read context exists; it lists the project's issues filtered by the shared `IssueFilter`; a row opens the full issue in place (wide: split beside the list, narrow: in place with a back button); the actions are "Attach to this session" (through `resolveComposerReferences`) and "Open on {provider}"; the filter and open item persist per project in `useIssuesPanelStore`.

- [x] **Step 6: Validate and commit**

Run: `bun run check:changed` (from the root) — expected PASS.
Run: `bun run docs:validate` — expected PASS.

```bash
git add packages/web/server/lib/source-control/DOCUMENTATION.md packages/web/server/lib/gitea/DOCUMENTATION.md packages/web/server/lib/forgejo/DOCUMENTATION.md packages/ui/src/components/references/DOCUMENTATION.md packages/ui/src/components/session/project-context/DOCUMENTATION.md
git commit -m "docs: issues panel reads, capability, shared filter and tab"
```

---

## Self-Review

- **Spec coverage:** Server milestone listing (Task 1-2), filter parameters on the issue list (Task 3), descriptor capability + publication + freeze (Task 2), API surface and adapters (Task 4), shared filter state and component (Task 5-6), Issues tab with gating/rows/detail/split/actions (Task 8), persistence (Task 8), board integration (Task 7), i18n (Task 9), docs (Task 10). All spec sections map to a task.
- **Placeholder scan:** No TBD/TODO; every code step shows the code. The list read takes the `IssueFilter` directly (no cast — Task 7 widened `useRepositoryReferenceList`'s `filter`). The single `as any` left in Task 8 builds a `RepositoryIssueReference` from the `Issue` detail DTO and is kept deliberately (the two shapes differ: `project: { owner, name }` vs. the row's `sourceRepo: { owner, repo }`).
- **Type consistency:** `MilestoneChoice`, `IssueFilter`, `DEFAULT_ISSUE_FILTER`, `useChoiceOptions`, `IssueFilterMenu`, `referenceMilestones` are defined once (Tasks 4-6) and referenced consistently in Tasks 7-8.
- **Review Focus:** All five lines are pinned — lines 1-2 in Task 5 (stale-keep and first-failure tests), line 3 in Task 6 (mixed-state test), line 4 in Task 8 (list-failure test), line 5 in Task 8 (gating test).



