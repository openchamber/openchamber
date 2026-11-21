import type { JsonObject, JsonValue } from '../shared/json-values.js';
import { isPlainObject, isString } from './validation.js';
import type { createGitLabClient } from './client.js';

const REFERENCE_NOTE = /^mentioned in /;
const REFERENCE_TOKEN = /(?:issue|merge request)\s+((?:[\w.-]+\/)*[\w.-]+)?([#!])(\d+)/g;

const sameNamespacePath = (path: string | undefined, ownPath: string): string => {
  if (!path) return ownPath;
  if (path.includes('/')) return path;
  const slash = ownPath.lastIndexOf('/');
  return slash > 0 ? `${ownPath.slice(0, slash)}/${path}` : path;
};

export interface GitLabReferenceLink {
  kind: 'issue' | 'pull';
  number: number;
  url: string;
  repo: string;
  createdAt: string | null;
  author: { login: string; avatarUrl?: string } | null;
}

type Client = ReturnType<typeof createGitLabClient>;
type Entry = JsonValue | undefined;
type ReferenceCarrier = { references?: GitLabReferenceLink[] };

const asArray = (value: Entry): JsonValue[] => (Array.isArray(value) ? value : []);
const objectOf = (value: Entry): JsonObject | null => (isPlainObject(value) ? value : null);

export const projectPath = (owner: string, name: string): string => `${owner}/${name}`;

export function systemReferences(notes: Entry, webUrl: string, ownPath: string): GitLabReferenceLink[] {
  let base: string;
  try {
    base = new URL(webUrl).origin;
  } catch {
    return [];
  }
  if (!isString(ownPath) || !ownPath) return [];
  const references: GitLabReferenceLink[] = [];
  for (const raw of asArray(notes)) {
    const note = objectOf(raw);
    if (!note || note.system !== true || !isString(note.body) || !REFERENCE_NOTE.test(note.body)) continue;
    const createdAt = isString(note.created_at) && note.created_at ? note.created_at : null;
    let author: GitLabReferenceLink['author'] = null;
    const noteAuthor = objectOf(note.author);
    if (noteAuthor && isString(noteAuthor.username) && noteAuthor.username) {
      author = { login: noteAuthor.username };
      if (isString(noteAuthor.avatar_url) && noteAuthor.avatar_url) author.avatarUrl = noteAuthor.avatar_url;
    }
    for (const [, path, marker, digits] of note.body.matchAll(REFERENCE_TOKEN)) {
      const number = Number(digits);
      if (!Number.isSafeInteger(number) || number < 1) continue;
      const repo = sameNamespacePath(path, ownPath);
      const mergeRequest = marker === '!';
      references.push({
        kind: mergeRequest ? 'pull' : 'issue',
        number,
        url: `${base}/${repo}/-/${mergeRequest ? 'merge_requests' : 'issues'}/${number}`,
        repo,
        createdAt,
        author,
      });
    }
  }
  return references.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
}

export async function readIssueReferences(
  client: Client,
  project: { id: string | number; owner: string; name: string },
  number: number,
  webUrl: string,
): Promise<GitLabReferenceLink[]> {
  try {
    const notes = await client.IssueNotes.all(project.id, number, {
      sort: 'desc', orderBy: 'created_at', perPage: 100, maxPages: 1,
    });
    return Array.isArray(notes) ? systemReferences(notes, webUrl, projectPath(project.owner, project.name)) : [];
  } catch {
    return [];
  }
}

export const withReferences = <T>(base: T, references: readonly GitLabReferenceLink[]): T & Partial<ReferenceCarrier> =>
  (references.length > 0 ? Object.assign({}, base, { references: [...references] }) : Object.assign({}, base));

export const withIssueReferences = async <T>(
  client: Client,
  project: { id: string | number; owner: string; name: string },
  issue: T,
  number: number,
  webUrl: string,
): Promise<T & Partial<ReferenceCarrier>> => withReferences(issue, await readIssueReferences(client, project, number, webUrl));
