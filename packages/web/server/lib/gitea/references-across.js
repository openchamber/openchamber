/**
 * The reference picker's search across a folder's repositories, for Gitea and
 * Forgejo. The board asks one provider for every repository under a project
 * folder; each folder arrives as its own bound read context.
 *
 * Gitea has no search that names a set of repositories, so a page is built by
 * reading the newest page of each folder's repository and merging them by
 * activity. That bounds a page to `MAX_PAGES_PER_REPO` pages per repository
 * (`4`, 200 items at Gitea's 50-item cap); deeper pages stop there rather than
 * pretend the folder holds nothing older. Pages are cached briefly so paging
 * does not read every repository again for each page.
 *
 * A pull request read through Gitea's issue search carries no head or base, so
 * only the items that land on the page are read as pull requests before they
 * are mapped. A repository with no remote on the instance is reported as
 * `no-repo`, a folder whose binding changed as `invalid-context`, and a gone
 * account as `disconnected`, the same statuses the GitHub search answers.
 */

import { z } from 'zod';
import { isPlainObject, isString } from '../shared/guards.js';
import { mapLimited } from '../shared/map-limited.js';

const PAGE_SIZE = 30;
// Gitea caps a page at `[api] MAX_RESPONSE_ITEMS` (50 by default).
const REPO_PAGE_LIMIT = 50;
const MAX_PAGES_PER_REPO = 4;
const ACROSS_CONCURRENCY = 4;
const DETAIL_CONCURRENCY = 4;
const BODY_PREVIEW_MAX = 20_000;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 400;
const MAX_CONTEXTS = 100;

const integer = (value) => (Number.isInteger(value) ? value : null);
const text = (value) => (isString(value) && value.trim() ? value : null);

const contextSchema = z.strictObject({
  directory: z.string().trim().min(1),
  repositoryId: z.string().min(1),
  provider: z.string().min(1),
  instance: z.string().min(1),
  accountId: z.string().min(1),
  bindingRevision: z.number().int().nonnegative(),
  primaryRemote: z.string().min(1),
});

const requestSchema = z.strictObject({
  contexts: z.array(contextSchema),
  kind: z.enum(['issue', 'pull', 'discussion']),
  state: z.enum(['open', 'closed', 'merged', 'all', 'unanswered']).optional(),
  people: z.enum(['any', 'assigned', 'created', 'reviewRequested']).optional(),
  query: z.string().optional(),
  // The first page sends no cursor as null, like the single-repository list.
  cursor: z.string().max(100_000).nullable().optional(),
});

const invalidCursor = () => Object.assign(new Error('Invalid references cursor'), {
  status: 400, code: 'INVALID_REFERENCES_CURSOR',
});

/** Validate the JSON read request before any folder or credential access. */
export function readReferencesAcrossRequest(body, providerId) {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return null;
  // One request goes to one provider; a context of another one is a caller bug.
  if (parsed.data.contexts.some((context) => context.provider !== providerId)) return null;
  const folders = new Map();
  for (const context of parsed.data.contexts) {
    if (!folders.has(context.directory)) folders.set(context.directory, context);
  }
  if (folders.size > MAX_CONTEXTS) return null;
  return {
    ...parsed.data,
    contexts: [...folders.values()],
    directories: parsed.data.contexts.map((context) => context.directory),
  };
}

const readCursor = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  if (!/^\d+$/.test(value)) throw invalidCursor();
  const offset = Number(value);
  if (!Number.isSafeInteger(offset)) throw invalidCursor();
  return offset;
};

const previewBody = (body) => {
  const value = isString(body) ? body : '';
  return value.length > BODY_PREVIEW_MAX
    ? { body: value.slice(0, BODY_PREVIEW_MAX), bodyTruncated: true }
    : { body: value, bodyTruncated: false };
};

const authorOf = (raw) => {
  const login = text(raw?.user?.login);
  if (!login) return null;
  const avatarUrl = text(raw.user.avatar_url);
  return avatarUrl ? { login, avatarUrl } : { login };
};

const labelsOf = (raw) => {
  if (!Array.isArray(raw?.labels)) return [];
  return raw.labels.flatMap((label) => {
    if (!isPlainObject(label) || !text(label.name)) return [];
    const mapped = { name: label.name };
    const color = text(label.color);
    if (color) mapped.color = color.replace(/^#/, '');
    return [mapped];
  });
};

const sourceRepoOf = (repo) => ({ owner: repo.owner, repo: repo.name, source: 'origin' });

/** One issue of the folder's repository as a picker item, or null when it does not map. */
export function issueReference(raw, repo, directory) {
  if (!isPlainObject(raw) || integer(raw.number) === null || !text(raw.title) || !text(raw.html_url)) return null;
  if (raw.pull_request != null) return null;
  if (raw.state !== 'open' && raw.state !== 'closed') return null;
  return {
    kind: 'issue',
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    ...previewBody(raw.body),
    createdAt: text(raw.created_at),
    updatedAt: text(raw.updated_at),
    author: authorOf(raw),
    labels: labelsOf(raw),
    commentCount: integer(raw.comments) ?? 0,
    sourceRepo: sourceRepoOf(repo),
    // Gitea sends no close reason, so a closed issue reads as done.
    state: raw.state === 'open' ? 'open' : 'completed',
    directory,
  };
}

const headRepoOf = (raw) => {
  const head = raw?.head?.repo;
  if (!isPlainObject(head)) return null;
  const owner = text(head.owner?.login);
  const name = text(head.name);
  if (!owner || !name || !text(head.html_url)) return null;
  const mapped = { owner, repo: name, url: head.html_url };
  const cloneUrl = text(head.clone_url);
  if (cloneUrl) mapped.cloneUrl = cloneUrl;
  const sshUrl = text(head.ssh_url);
  if (sshUrl) mapped.sshUrl = sshUrl;
  return mapped;
};

/** One pull request of the folder's repository as a picker item, or null when it does not map. */
export function pullReference(raw, repo, directory) {
  if (!isPlainObject(raw) || integer(raw.number) === null || !text(raw.title) || !text(raw.html_url)) return null;
  if (!text(raw.head?.ref) || !text(raw.base?.ref) || !text(raw.head?.sha)) return null;
  const state = raw.merged === true ? 'merged' : raw.state;
  if (state !== 'open' && state !== 'closed' && state !== 'merged') return null;
  // Gitea's own work-in-progress prefixes (`[repository.pull-request] WORK_IN_PROGRESS_PREFIXES`).
  const draft = raw.draft === true || /^\s*(?:wip:|\[wip\])\s*/i.test(raw.title);
  return {
    kind: 'pull',
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    ...previewBody(raw.body),
    createdAt: text(raw.created_at),
    updatedAt: text(raw.updated_at),
    author: authorOf(raw),
    labels: labelsOf(raw),
    commentCount: integer(raw.comments) ?? 0,
    sourceRepo: sourceRepoOf(repo),
    state,
    draft,
    head: raw.head.ref,
    base: raw.base.ref,
    headSha: raw.head.sha,
    headRepo: headRepoOf(raw),
    directory,
  };
}

const failureStatus = (error) => {
  if (error?.sourceControlAccountUnavailable) return 'disconnected';
  if ((error?.status ?? error?.response?.status) === 401) return 'disconnected';
  if (error?.code === 'SOURCE_CONTROL_NO_REPOSITORY') return 'no-repo';
  if (error?.code?.startsWith('SOURCE_CONTROL_BINDING_') || error?.code?.startsWith('SOURCE_CONTROL_LOCK_')
    || error?.code === 'INVALID_SOURCE_CONTROL_READ_CONTEXT' || error?.code === 'INVALID_SOURCE_CONTROL_BINDING') {
    return 'invalid-context';
  }
  return 'error';
};

// Per-repository pages are read again for the next page of the same search;
// a short cache keeps paging from re-reading every repository each time.
const pageCache = new Map();

/** Drop every cached page; tests use it between cases. */
export const resetReferencePageCache = () => pageCache.clear();

const cachedPage = async (key, read) => {
  const now = Date.now();
  const held = pageCache.get(key);
  if (held && now - held.at < CACHE_TTL_MS) return held.value;
  const value = await read();
  pageCache.delete(key);
  pageCache.set(key, { at: now, value });
  while (pageCache.size > CACHE_MAX_ENTRIES) {
    pageCache.delete(pageCache.keys().next().value);
  }
  return value;
};

const activity = (raw) => Date.parse(raw?.updated_at) || 0;

/**
 * The board's search across the folder's repositories. `input` is
 * `readReferencesAcrossRequest`'s answer; `validateReadContext` returns the
 * trusted context for a folder, and `resolveService` the resource service
 * that reads it. `onFolderFailure` sees every folder failure with the
 * identity it was read under, so a refused account can be marked invalid.
 */
export async function readReferencesAcross({
  input, providerId, validateReadContext, resolveService, onFolderFailure,
}) {
  const offset = readCursor(input.cursor);
  const kind = input.kind;
  const state = input.state ?? 'open';
  const people = input.people ?? 'any';
  const query = input.query?.trim() ?? '';

  // No Gitea discussion search: the tab is absent on these providers, and an
  // asked-for one answers empty rather than failing the page.
  if (kind === 'discussion') {
    return {
      items: [],
      cursor: null,
      hasMore: false,
      total: 0,
      repositories: input.directories.map((directory) => ({ directory, status: 'included', repo: null })),
    };
  }

  const folders = new Map();
  const services = new Map();

  // A folder's failure is its own: the caller may mark a refused account, and
  // the status keeps the rest of the page answering.
  const failed = async (error, identity) => {
    if (onFolderFailure) await onFolderFailure(error, identity);
    return failureStatus(error);
  };

  await mapLimited(input.contexts, ACROSS_CONCURRENCY, async (context) => {
    const directory = context.directory;
    let trusted;
    try {
      trusted = await validateReadContext({ ...context, provider: providerId });
    } catch (error) {
      folders.set(directory, { status: await failed(error, context) });
      return;
    }
    if (!trusted) {
      folders.set(directory, { status: 'invalid-context' });
      return;
    }
    try {
      const accountKey = `${trusted.instance ?? ''}|${trusted.accountId ?? ''}`;
      let service = services.get(accountKey);
      if (!service) {
        service = await resolveService(trusted);
        services.set(accountKey, service);
      }
      folders.set(directory, { trusted, service });
    } catch (error) {
      folders.set(directory, { status: await failed(error, trusted) });
    }
  });

  // Enough pages per repository that the next window can be told to have
  // more, within the cap: one more page than the offset itself needs.
  const pages = Math.min(MAX_PAGES_PER_REPO, Math.floor((offset + PAGE_SIZE) / REPO_PAGE_LIMIT) + 1);
  const candidates = [];

  await mapLimited([...folders.entries()], ACROSS_CONCURRENCY, async ([directory, entry]) => {
    if (entry.status) return;
    try {
      for (let page = 1; page <= pages; page += 1) {
        const key = JSON.stringify([
          providerId, entry.trusted.instance ?? '', entry.trusted.accountId ?? '',
          directory, entry.trusted.primaryRemote ?? '', kind, state, people, query, page,
        ]);
        const result = await cachedPage(key, () => entry.service.listReferenceCandidates(directory, {
          kind, state, people, query, page, remote: entry.trusted.primaryRemote,
        }));
        entry.repo ??= result.repo;
        for (const raw of result.items) {
          candidates.push({ raw, repo: result.repo, needsDetail: result.needsDetail === true, directory, entry });
        }
        if (!result.hasMore) break;
      }
      if (!entry.repo) entry.status = 'no-repo';
    } catch (error) {
      entry.status = await failed(error, entry.trusted);
    }
  });

  candidates.sort((a, b) => {
    const byActivity = activity(b.raw) - activity(a.raw);
    return byActivity !== 0 ? byActivity : (integer(b.raw?.number) ?? 0) - (integer(a.raw?.number) ?? 0);
  });

  const window = candidates.slice(offset, offset + PAGE_SIZE);
  const items = (await mapLimited(window, DETAIL_CONCURRENCY, async (candidate) => {
    let raw = candidate.raw;
    if (candidate.needsDetail) {
      try {
        raw = await candidate.entry.service.readPullDetail(
          candidate.directory, candidate.raw.number, candidate.entry.trusted.primaryRemote,
        );
      } catch (error) {
        // The pull request moved or went away between the list and this read;
        // the rest of the page still answers.
        return null;
      }
    }
    return kind === 'pull'
      ? pullReference(raw, candidate.repo, candidate.directory)
      : issueReference(raw, candidate.repo, candidate.directory);
  })).filter(Boolean);

  const hasMore = candidates.length > offset + PAGE_SIZE;
  const repositories = input.directories.map((directory) => {
    const entry = folders.get(directory);
    if (!entry || entry.status || !entry.repo) return { directory, status: entry?.status ?? 'error' };
    return {
      directory,
      status: 'included',
      repo: { owner: entry.repo.owner, repo: entry.repo.name, url: entry.repo.url },
    };
  });

  return {
    items,
    cursor: hasMore ? String(offset + PAGE_SIZE) : null,
    hasMore,
    total: candidates.length,
    repositories,
  };
}
