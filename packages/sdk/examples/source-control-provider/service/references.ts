type SourceControlReferenceLink = {
  kind: 'issue' | 'pull';
  number: number;
  url: string;
  createdAt: string | null;
  title?: string;
  repo?: string;
  author?: { login: string; avatarUrl?: string };
};

export type ReferenceUser = { login?: string; avatar_url?: string };

export type ReferenceTarget = {
  number?: number;
  html_url?: string;
  title?: string;
  repository?: { full_name?: string };
  pull_request?: object | null;
};

export type ReferenceEvent = {
  type?: string;
  created_at?: string;
  user?: ReferenceUser;
  ref_issue?: ReferenceTarget;
  ref_comment?: { created_at?: string; user?: ReferenceUser };
};

type ReferenceAuthor = { login: string; avatarUrl?: string };

type TimelinePage = { data: ReferenceEvent[] | null; total: number | null };
export type TimelineRead = (page: number, limit: number) => Promise<TimelinePage>;

const PAGE_LIMIT = 50;
// The references are optional: stop waiting well before the host's 20-second read deadline,
// so a slow timeline never costs the item its detail.
const REFERENCE_BUDGET_MS = 8_000;

const REFERENCE_EVENT_TYPES = new Set(['issue_ref', 'pull_ref', 'comment_ref']);

const authorOf = (user: ReferenceUser | undefined): ReferenceAuthor | undefined => {
  if (!user) return undefined;
  const login = user.login;
  if (!login || String(login) !== login) return undefined;
  const author: ReferenceAuthor = { login };
  const avatar = user.avatar_url;
  if (avatar && String(avatar) === avatar) author.avatarUrl = avatar;
  return author;
};

const isPullTarget = (event: ReferenceEvent, target: ReferenceTarget, url: string): boolean =>
  event.type === 'pull_ref'
  || (target.pull_request !== null && Object(target.pull_request) === target.pull_request)
  || /\/pulls\/\d+(?:$|[?#/])/.test(url);

export const mapTimelineReferences = (entries: ReferenceEvent[] | null): SourceControlReferenceLink[] => {
  const references = new Map<string, SourceControlReferenceLink>();
  for (const event of entries ?? []) {
    if (!event || !REFERENCE_EVENT_TYPES.has(String(event.type))) continue;
    const target = event.ref_issue;
    if (!target || !Number.isSafeInteger(target.number)) continue;
    const url = target.html_url;
    if (!url || String(url) !== url) continue;
    const comment = event.type === 'comment_ref' ? event.ref_comment : undefined;
    const created = comment?.created_at ?? event.created_at;
    const createdAt = created && String(created) === created ? created : null;
    const reference: SourceControlReferenceLink = {
      kind: isPullTarget(event, target, url) ? 'pull' : 'issue',
      number: Number(target.number),
      url,
      createdAt,
    };
    const title = target.title;
    if (title && String(title) === title) reference.title = title;
    const repo = target.repository?.full_name;
    if (repo && String(repo) === repo) reference.repo = repo;
    const author = authorOf(comment?.user ?? event.user);
    if (author) reference.author = author;
    const previous = references.get(reference.url);
    if (!previous || String(createdAt ?? '') < String(previous.createdAt ?? '')) references.set(reference.url, reference);
  }
  return [...references.values()].sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
};

// The timeline pages every event oldest first; past the first page, also read the last two
// so a recent mention is not lost behind older comments and state changes.
const timelineEvents = async (read: TimelineRead): Promise<ReferenceEvent[]> => {
  const first = await read(1, PAGE_LIMIT);
  const pages = first.total ? Math.ceil(first.total / PAGE_LIMIT) : 1;
  const later = await Promise.all([pages - 1, pages].filter((page) => page > 1).map((page) => read(page, PAGE_LIMIT).catch(() => null)));
  return [first, ...later].flatMap((page) => page?.data ?? []);
};

export const readReferences = async (read: TimelineRead | null, budgetMs = REFERENCE_BUDGET_MS): Promise<SourceControlReferenceLink[]> => {
  if (read === null) return [];
  const events = timelineEvents(read);
  events.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); });
  try {
    const entries = await Promise.race([events, expired]);
    return entries ? mapTimelineReferences(entries) : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
};

export const withReferences = <T extends object>(detail: T, references: SourceControlReferenceLink[]): T & { references?: SourceControlReferenceLink[] } =>
  (references.length > 0 ? { ...detail, references } : detail);

export type ReferencesApi = {
  readReferences: (read: TimelineRead | null, budgetMs?: number) => Promise<SourceControlReferenceLink[]>;
  withReferences: <T extends object>(detail: T, references: SourceControlReferenceLink[]) => T & { references?: SourceControlReferenceLink[] };
};

export const itemReferences = <Call>(
  api: <T>(call: Call, method: 'GET', path: string, options: { query: Record<string, string> }) => Promise<{ data: T; total: number | null }>,
  call: Call,
  repo: string,
  number: number,
  include: boolean,
): TimelineRead | null => (include ? (page, limit) => api<ReferenceEvent[]>(call, 'GET', `${repo}/issues/${number}/timeline`, {
  query: { page: String(page), limit: String(limit) },
}) : null);
