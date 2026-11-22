import { z } from 'zod';

/**
 * The user's link operations, from the UI (`setLinkedIssue` and
 * `addLinkedIssues` in `packages/ui/src/sync/session-actions.ts`).
 *
 * The UI used to read the session, compute the whole `linked_issues` array and
 * send it in a merge patch. A snapshot taken while an agent was linking the
 * same session then came back and erased the agent's link: the per-session
 * write queue serializes the writes, but the client's list was already stale.
 * The transform runs here now, against the record as it is when this
 * session's write turn comes (`updateSessionMetadata`), so whichever writer
 * goes first, the other reads a record that includes it.
 *
 * The entry shapes are the UI's (`packages/ui/src/lib/linkedIssues.ts`), under
 * `openchamber.linked_issues`. An entry is a UI-owned snapshot: validation
 * checks what identity needs, and the rest (author, avatar, guest payload,
 * thread) rides along untouched.
 */

const LINKED_ISSUE_KINDS = ['issue', 'pull', 'linear', 'guest', 'external'];

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
  constructor(message) {
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

/** Validates one UI link request. Invalid input never reaches the record. */
export const parseLinkOperation = (payload) => {
  const parsed = linkOperationSchema.safeParse(payload ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
    return { ok: false, error: `invalid link operation${where}: ${issue?.message ?? 'expected entries and linked'}` };
  }
  return { ok: true, entries: parsed.data.entries, linked: parsed.data.linked };
};

const normalizedThreadUrl = (url) => url.trim().replace(/\/+$/, '').toLowerCase();

/** The list on a record, however bare the record is. */
const linkedIssuesSchema = z.looseObject({
  openchamber: z.looseObject({ linked_issues: z.array(z.unknown()).catch([]) }).catch({ linked_issues: [] }),
}).catch({ openchamber: { linked_issues: [] } });

/**
 * What identity reads from a stored entry. `number` is optional: only the
 * legacy fallback needs it, and a stored entry with an unusable number must
 * still match by its id.
 */
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
const identityKeysOfStored = (stored) => {
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

const identityKeysOfIncoming = (incoming) => {
  const keys = [];
  if (z.string().safeParse(incoming?.id).success) keys.push(`id:${incoming.id}`);
  if ((incoming?.kind === 'issue' || incoming?.kind === 'pull')
    && Number.isFinite(incoming?.number) && z.string().safeParse(incoming?.url).success) {
    keys.push(`legacy:${incoming.kind}:${incoming.number}:${normalizedThreadUrl(incoming.url)}`);
  }
  return keys;
};

/**
 * The merge patch that applies the operation to the record's list, or null
 * when it would change nothing. Every same-identity entry is removed, and a
 * link appends the incoming entry at the end: a re-link is how a stale title
 * gets refreshed. Sibling metadata and stored entries this operation does not
 * touch are kept, whatever their shape.
 */
export const buildLinkedIssuesPatch = (metadata, entries, linked) => {
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
