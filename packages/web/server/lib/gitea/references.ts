import { isPlainObject, isString } from '../shared/guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { createGiteaClient } from './client.js';
import { mapGiteaCommit } from './mappers.js';

const PAGE_LIMIT = 50;
const TIMELINE_COMMIT_LIMIT = 50;
const REFERENCE_EVENT_TYPES = new Set(['issue_ref', 'pull_ref', 'comment_ref']);

export interface GiteaReferenceLink {
  kind: 'issue' | 'pull';
  number: number;
  url: string;
  createdAt: string | null;
  title?: string;
  repo?: string;
  author?: { login: string; avatarUrl?: string };
}

type GiteaClient = ReturnType<typeof createGiteaClient>;
type Entry = JsonValue | undefined;
type ReferenceCarrier = { references?: GiteaReferenceLink[] };

const objectOf = (value: Entry): JsonObject | null => (isPlainObject(value) ? value : null);
const integer = (value: JsonValue | undefined): value is number => Number.isSafeInteger(value);

const isPullTarget = (entry: JsonObject, target: JsonObject): boolean =>
  entry.type === 'pull_ref'
  || isPlainObject(target.pull_request)
  || (isString(target.html_url) && /\/pulls\/\d+(?:$|[?#/])/.test(target.html_url));

const userOf = (value: Entry): GiteaReferenceLink['author'] => {
  const user = objectOf(value);
  if (!user || !isString(user.login) || !user.login) return undefined;
  return isString(user.avatar_url) && user.avatar_url
    ? { login: user.login, avatarUrl: user.avatar_url }
    : { login: user.login };
};

export const withReferences = <T>(base: T, references: readonly GiteaReferenceLink[]): T & Partial<ReferenceCarrier> =>
  (references.length > 0 ? Object.assign({}, base, { references: [...references] }) : Object.assign({}, base));

export const readTimelineCommits = async (client: GiteaClient, repo: string, number: number) => {
  const first = await client.page(`${repo}/pulls/${number}/commits`, { files: false, verification: false }, { page: 1, limit: TIMELINE_COMMIT_LIMIT });
  const items = first.items.flatMap((commit) => {
    const mapped = mapGiteaCommit(commit);
    return mapped ? [mapped] : [];
  }).reverse();
  return { items, complete: !first.hasMore };
};

export async function readTimelineReferences(client: GiteaClient, repo: string, number: number): Promise<GiteaReferenceLink[]> {
  const path = `${repo}/issues/${number}/timeline`;
  const events: JsonValue[] = [];
  try {
    const first = await client.page(path, {}, { page: 1, limit: PAGE_LIMIT });
    events.push(...first.items);
    const pages = first.hasMore && first.total ? Math.ceil(first.total / PAGE_LIMIT) : 1;
    const recent = [pages - 1, pages].filter((index) => index > 1);
    const later = await Promise.all(recent.map((index) => client.page(path, {}, { page: index, limit: PAGE_LIMIT }).catch(() => null)));
    for (const page of later) if (page) events.push(...page.items);
  } catch {
    return [];
  }
  const references = new Map<string, GiteaReferenceLink>();
  for (const raw of events) {
    const entry = objectOf(raw);
    const target = entry ? objectOf(entry.ref_issue) : null;
    if (!entry || !REFERENCE_EVENT_TYPES.has(String(entry.type))
      || !target || !integer(target.number) || !isString(target.html_url) || !target.html_url) continue;
    const comment = entry.type === 'comment_ref' ? objectOf(entry.ref_comment) : null;
    const createdAt = comment && isString(comment.created_at) && comment.created_at
      ? comment.created_at
      : (isString(entry.created_at) && entry.created_at ? entry.created_at : null);
    const reference: GiteaReferenceLink = {
      kind: isPullTarget(entry, target) ? 'pull' : 'issue',
      number: target.number,
      url: target.html_url,
      createdAt,
    };
    const repository = objectOf(target.repository);
    if (isString(target.title) && target.title) reference.title = target.title;
    if (repository && isString(repository.full_name) && repository.full_name) reference.repo = repository.full_name;
    const author = userOf(comment?.user ?? entry.user);
    if (author) reference.author = author;
    const previous = references.get(reference.url);
    if (!previous || String(createdAt ?? '') < String(previous.createdAt ?? '')) references.set(reference.url, reference);
  }
  return [...references.values()].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
}

export const withIssueReferences = async <T>(
  client: GiteaClient, repo: string, issue: T, number: number,
): Promise<T & Partial<ReferenceCarrier>> => withReferences(issue, await readTimelineReferences(client, repo, number));
