import { resolveRepoFromDirectory } from './githubPr';

const API_BASE = 'https://api.github.com';

type JsonRecord = Record<string, unknown>;

type GitHubRepoRef = { owner: string; repo: string; url: string };

type GitHubIssuesListResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  issues?: Array<{
    number: number;
    title: string;
    url: string;
    state: 'open' | 'closed';
    author?: { login: string; id?: number; avatarUrl?: string; name?: string; email?: string } | null;
    labels?: Array<{ name: string; color?: string }>;
  }>;
  page?: number;
  hasMore?: boolean;
};

type GitHubIssueGetResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  issue?: {
    number: number;
    title: string;
    url: string;
    state: 'open' | 'closed';
    author?: { login: string; id?: number; avatarUrl?: string; name?: string; email?: string } | null;
    labels?: Array<{ name: string; color?: string }>;
    body?: string;
    assignees?: Array<{ login: string; id?: number; avatarUrl?: string; name?: string; email?: string }>;
    createdAt?: string;
    updatedAt?: string;
  } | null;
};

type GitHubIssueCommentsResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  comments?: Array<{
    id: number;
    url: string;
    body: string;
    author?: { login: string; id?: number; avatarUrl?: string; name?: string; email?: string } | null;
    createdAt?: string;
    updatedAt?: string;
  }>;
};

const githubFetch = async (
  url: string,
  accessToken: string,
  init?: RequestInit,
): Promise<Response> => {
  return fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'OpenChamber',
      ...(init?.headers || {}),
    },
  });
};

const jsonOrNull = async <T>(response: Response): Promise<T | null> => {
  return (await response.json().catch(() => null)) as T | null;
};

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');

const mapUser = (raw: unknown) => {
  const rec = raw && typeof raw === 'object' ? (raw as JsonRecord) : null;
  const login = readString(rec?.login);
  if (!login) return null;
  return {
    login,
    id: typeof rec?.id === 'number' ? rec.id : undefined,
    avatarUrl: readString(rec?.avatar_url) || undefined,
    name: undefined,
    email: undefined,
  };
};

const mapLabels = (raw: unknown): Array<{ name: string; color?: string }> => {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((item) => {
      const rec = item && typeof item === 'object' ? (item as JsonRecord) : null;
      const name = readString(rec?.name);
      if (!name) return null;
      return {
        name,
        color: readString(rec?.color) || undefined,
      };
    })
    .filter(Boolean) as Array<{ name: string; color?: string }>;
};

export const listIssues = async (
  accessToken: string,
  directory: string,
  page: number = 1,
  searchQuery?: string,
): Promise<GitHubIssuesListResult> => {
  const repo = await resolveRepoFromDirectory(directory);
  if (!repo) {
    return { connected: true, repo: null, issues: [] };
  }

  if (searchQuery) {
    const q = `repo:${repo.owner}/${repo.repo} ${searchQuery} type:issue state:open`;
    const url = new URL(`${API_BASE}/search/issues`);
    url.searchParams.set('q', q);
    url.searchParams.set('per_page', '50');
    url.searchParams.set('page', String(page));

    const resp = await githubFetch(url.toString(), accessToken);
    if (resp.status === 401) {
      return { connected: false };
    }

    const json = await jsonOrNull<{ total_count?: number; items?: unknown[] }>(resp);
    if (!resp.ok || !json) {
      throw new Error('Failed to search issues');
    }

    const totalCount = typeof json.total_count === 'number' ? json.total_count : 0;
    const items = Array.isArray(json.items) ? json.items : [];
    const issues = items
      .map((entry) => {
        const rec = entry && typeof entry === 'object' ? (entry as JsonRecord) : null;
        if (!rec || rec.pull_request) return null;
        const number = typeof rec.number === 'number' ? rec.number : 0;
        if (!number) return null;
        const state = readString(rec.state) === 'closed' ? 'closed' : 'open';
        return {
          number,
          title: readString(rec.title) || '',
          url: readString(rec.html_url) || '',
          state,
          author: mapUser(rec.user),
          labels: mapLabels(rec.labels),
        };
      })
      .filter(Boolean) as GitHubIssuesListResult['issues'];

    const fetchedCount = (page - 1) * 50 + items.length;
    const hasMore = fetchedCount < totalCount;
    return { connected: true, repo, issues: issues || [], page, hasMore };
  }

  const url = new URL(`${API_BASE}/repos/${repo.owner}/${repo.repo}/issues`);
  url.searchParams.set('state', 'open');
  url.searchParams.set('per_page', '50');
  url.searchParams.set('page', String(page));

  const resp = await githubFetch(url.toString(), accessToken);
  if (resp.status === 401) {
    return { connected: false };
  }

  const link = resp.headers.get('link') || '';
  const hasMore = /rel="next"/.test(link);

  const json = await jsonOrNull<unknown[]>(resp);
  if (!resp.ok || !Array.isArray(json)) {
    throw new Error('Failed to load issues');
  }

  const issues = json
    .map((entry) => {
      const rec = entry && typeof entry === 'object' ? (entry as JsonRecord) : null;
      if (!rec || rec.pull_request) return null;
      const number = typeof rec.number === 'number' ? rec.number : 0;
      if (!number) return null;
      const state = readString(rec.state) === 'closed' ? 'closed' : 'open';
      return {
        number,
        title: readString(rec.title) || '',
        url: readString(rec.html_url) || '',
        state,
        author: mapUser(rec.user),
        labels: mapLabels(rec.labels),
      };
    })
    .filter(Boolean) as GitHubIssuesListResult['issues'];

  return { connected: true, repo, issues: issues || [], page, hasMore };
};

export const getIssue = async (
  accessToken: string,
  directory: string,
  number: number,
): Promise<GitHubIssueGetResult> => {
  const repo = await resolveRepoFromDirectory(directory);
  if (!repo) {
    return { connected: true, repo: null, issue: null };
  }

  const resp = await githubFetch(`${API_BASE}/repos/${repo.owner}/${repo.repo}/issues/${number}`, accessToken);
  if (resp.status === 401) {
    return { connected: false };
  }
  const json = await jsonOrNull<JsonRecord>(resp);
  if (!resp.ok || !json) {
    throw new Error('Failed to load issue');
  }
  if (json.pull_request) {
    throw new Error('Not a GitHub issue');
  }

  const state = readString(json.state) === 'closed' ? 'closed' : 'open';
  const assigneesRaw = Array.isArray(json.assignees) ? json.assignees : [];
  const assignees = assigneesRaw.map(mapUser).filter(Boolean) as Array<NonNullable<ReturnType<typeof mapUser>>>;

  return {
    connected: true,
    repo,
    issue: {
      number: typeof json.number === 'number' ? json.number : number,
      title: readString(json.title) || '',
      url: readString(json.html_url) || '',
      state,
      author: mapUser(json.user),
      labels: mapLabels(json.labels),
      body: readString(json.body) || '',
      assignees,
      createdAt: readString(json.created_at) || undefined,
      updatedAt: readString(json.updated_at) || undefined,
    },
  };
};

export const listIssueComments = async (
  accessToken: string,
  directory: string,
  number: number,
): Promise<GitHubIssueCommentsResult> => {
  const repo = await resolveRepoFromDirectory(directory);
  if (!repo) {
    return { connected: true, repo: null, comments: [] };
  }

  const url = new URL(`${API_BASE}/repos/${repo.owner}/${repo.repo}/issues/${number}/comments`);
  url.searchParams.set('per_page', '100');

  const resp = await githubFetch(url.toString(), accessToken);
  if (resp.status === 401) {
    return { connected: false };
  }
  const json = await jsonOrNull<unknown[]>(resp);
  if (!resp.ok || !Array.isArray(json)) {
    throw new Error('Failed to load issue comments');
  }

  const comments = json
    .map((entry) => {
      const rec = entry && typeof entry === 'object' ? (entry as JsonRecord) : null;
      if (!rec) return null;
      const id = typeof rec.id === 'number' ? rec.id : 0;
      if (!id) return null;
      return {
        id,
        url: readString(rec.html_url) || '',
        body: readString(rec.body) || '',
        author: mapUser(rec.user),
        createdAt: readString(rec.created_at) || undefined,
        updatedAt: readString(rec.updated_at) || undefined,
      };
    })
    .filter(Boolean) as GitHubIssueCommentsResult['comments'];

  return { connected: true, repo, comments: comments || [] };
};
