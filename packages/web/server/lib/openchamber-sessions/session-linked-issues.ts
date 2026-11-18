import { z } from 'zod';
import type { JsonValue } from '@opencode/client';
import type { SessionPayload } from './routes.js';
import type { SessionMetadata } from './session-metadata-store.js';


const LINKED_ISSUE_KINDS = ['issue', 'pull', 'tracker', 'linear', 'guest', 'external'] as const;

export interface LinkedEntryIdentity {
  id: string;
  url?: string | undefined;
  kind?: string | undefined;
  number?: unknown;
}

export type LinkedIssuesPatch = {
  openchamber: { linked_issues: unknown[] };
}

const linkedEntrySchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1),
  kind: z.enum(LINKED_ISSUE_KINDS),
});

const linkOperationSchema = z.object({
  entries: z.array(linkedEntrySchema),
  linked: z.boolean(),
});

export const parseLinkOperation = (payload: SessionPayload | JsonValue | undefined) => {
  const parsed = linkOperationSchema.safeParse(payload ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
    return { ok: false as const, error: `invalid link operation${where}: ${issue?.message ?? 'expected entries and linked'}` };
  }
  return { ok: true as const, entries: parsed.data.entries, linked: parsed.data.linked };
};

const normalizedThreadUrl = (url: string | undefined) => {
  if (url === undefined) throw new TypeError("Cannot read properties of undefined (reading 'trim')");
  return url.trim().replace(/\/+$/, '').toLowerCase();
};

const linkedIssuesSchema = z.looseObject({
  openchamber: z.looseObject({ linked_issues: z.array(z.unknown()).catch([]) }).catch({ linked_issues: [] }),
}).catch({ openchamber: { linked_issues: [] } });

const storedEntrySchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  kind: z.string(),
  number: z.number().optional(),
});

const isSameLinkedEntry = (item: z.infer<typeof storedEntrySchema>, incoming: LinkedEntryIdentity) => {
  if (item.id === incoming.id) return true;
  return (item.kind === 'issue' || item.kind === 'pull')
    && item.kind === incoming.kind
    && item.number !== undefined
    && Number.isFinite(item.number) && Number.isFinite(incoming.number)
    && item.number === incoming.number
    && normalizedThreadUrl(item.url) === normalizedThreadUrl(incoming.url);
};

export const buildLinkedIssuesPatch = (metadata: SessionMetadata | JsonValue | undefined, entries: readonly LinkedEntryIdentity[], linked: boolean): LinkedIssuesPatch | null => {
  const current = linkedIssuesSchema.parse(metadata ?? {}).openchamber.linked_issues;

  let next = current;
  for (const entry of entries) {
    next = next.filter((item) => {
      const parsed = storedEntrySchema.safeParse(item);
      return !parsed.success || !isSameLinkedEntry(parsed.data, entry);
    });
    if (linked) next = [...next, entry];
  }
  if (next === current || JSON.stringify(next) === JSON.stringify(current)) return null;
  return { openchamber: { linked_issues: next } };
};
