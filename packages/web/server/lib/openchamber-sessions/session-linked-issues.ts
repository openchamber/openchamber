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

/**
 * Bounds (#2138). A link operation is a small UI gesture, not a bulk import,
 * so the incoming batch and the identity fields are capped here, at the
 * schema: an over-limit operation is rejected before any metadata is read
 * or written. The title cap matches the one `session-link.js` already
 * applies to stored titles.
 *
 * The stored list is capped as well — in entries and in serialized size —
 * so repeated valid requests cannot grow `openchamber.linked_issues`
 * without limit. A link whose result would cross a stored cap is rejected
 * whole with `LinkedIssuesLimitError` (a 400 at the route), never applied
 * partially. Unlinks are never rejected by the stored caps, so a legacy
 * list that is already oversized can always shrink back under them, and
 * links resume once it does.
 */
export const MAX_LINK_OPERATION_ENTRIES = 50;
export const MAX_LINKED_ISSUE_ID_LENGTH = 256;
export const MAX_LINKED_ISSUE_TITLE_LENGTH = 300;
export const MAX_LINKED_ISSUE_URL_LENGTH = 2048;
export const MAX_LINKED_ISSUES = 100;
export const MAX_LINKED_ISSUES_SERIALIZED_LENGTH = 65536;

/** A stored-list bound was crossed; carries the 400 the route answers. */
export class LinkedIssuesLimitError extends Error {
  statusCode: number;
  constructor(message: string) {
    super(message);
    this.name = 'LinkedIssuesLimitError';
    this.statusCode = 400;
  }
}

const linkedEntrySchema = z.looseObject({
  id: z.string().min(1).max(MAX_LINKED_ISSUE_ID_LENGTH),
  title: z.string().min(1).max(MAX_LINKED_ISSUE_TITLE_LENGTH),
  url: z.string().min(1).max(MAX_LINKED_ISSUE_URL_LENGTH),
  kind: z.enum(LINKED_ISSUE_KINDS),
});

const linkOperationSchema = z.object({
  entries: z.array(linkedEntrySchema).max(MAX_LINK_OPERATION_ENTRIES),
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

/**
 * The identity keys under which an entry can name a thread: its id, and —
 * for a repository entry stored before ids carried the host — its kind,
 * number and address however it was written. Two entries name the same
 * thread exactly when they share a key, so matching a whole batch is set
 * membership, checked once per entry, instead of a full list scan per
 * incoming entry.
 */
const identityKeysOfStored = <Entry>(stored: Entry) => {
  const parsed = storedEntrySchema.safeParse(stored);
  if (!parsed.success) return [];
  const item = parsed.data;
  const keys = [`id:${item.id}`];
  if ((item.kind === 'issue' || item.kind === 'pull')
    && item.number !== undefined && Number.isFinite(item.number)) {
    keys.push(`legacy:${item.kind}:${item.number}:${normalizedThreadUrl(item.url)}`);
  }
  return keys;
};

const incomingIdentitySchema = z.object({
  id: z.string().optional().catch(undefined),
  kind: z.unknown(),
  number: z.number().optional().catch(undefined),
  url: z.string().optional().catch(undefined),
});

const identityKeysOfIncoming = (raw: LinkedEntryIdentity) => {
  const keys: string[] = [];
  const incoming = incomingIdentitySchema.safeParse(raw).data;
  if (!incoming) return keys;
  if (incoming.id !== undefined) keys.push(`id:${incoming.id}`);
  if ((incoming.kind === 'issue' || incoming.kind === 'pull')
    && incoming.number !== undefined && Number.isFinite(incoming.number) && incoming.url !== undefined) {
    keys.push(`legacy:${incoming.kind}:${incoming.number}:${normalizedThreadUrl(incoming.url)}`);
  }
  return keys;
};

export const buildLinkedIssuesPatch = (metadata: SessionMetadata | JsonValue | undefined, entries: readonly LinkedEntryIdentity[], linked: boolean): LinkedIssuesPatch | null => {
  const current = linkedIssuesSchema.parse(metadata ?? {}).openchamber.linked_issues;

  // One bounded pass over the stored list: an entry survives only when no
  // incoming entry shares one of its identity keys.
  const incomingKeys = new Set();
  for (const entry of entries) {
    for (const key of identityKeysOfIncoming(entry)) incomingKeys.add(key);
  }
  const kept = current.filter(
    (item) => !identityKeysOfStored(item).some((key) => incomingKeys.has(key)),
  );

  let next = kept;
  if (linked) {
    // Within the batch, the last entry holding an identity key wins — the
    // remove-then-append loop this replaces dropped the earlier holders —
    // and the survivors append in batch order.
    const lastHolder = new Map();
    entries.forEach((entry, index) => {
      for (const key of identityKeysOfStored(entry)) lastHolder.set(key, index);
    });
    const appended = entries.filter((entry, index) => identityKeysOfStored(entry)
      .every((key) => lastHolder.get(key) === index));
    next = [...kept, ...appended];
  }

  const serializedNext = JSON.stringify(next);
  if (serializedNext === JSON.stringify(current)) return null;
  if (linked) {
    // The throw happens inside the metadata decide step, before any write:
    // a rejected link changes nothing. Unlinks skip these checks entirely,
    // so an oversized legacy list can always shrink (see Bounds, above).
    if (next.length > MAX_LINKED_ISSUES) {
      throw new LinkedIssuesLimitError(
        `too many linked issues: a session can link at most ${MAX_LINKED_ISSUES} entries`,
      );
    }
    if (serializedNext.length > MAX_LINKED_ISSUES_SERIALIZED_LENGTH) {
      throw new LinkedIssuesLimitError(
        `linked issues are too large: the stored list can serialize to at most ${MAX_LINKED_ISSUES_SERIALIZED_LENGTH} characters`,
      );
    }
  }
  return { openchamber: { linked_issues: next } };
};
