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

// `linear` is the legacy name of a Linear `tracker` entry; both stay valid.
const LINKED_ISSUE_KINDS = ['issue', 'pull', 'tracker', 'linear', 'guest', 'external'];

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
 * Whether a stored entry and an incoming one name the same thread: the same
 * id, or — for a repository entry stored before ids carried the host — the
 * same kind, number and address however it was written.
 */
const isSameLinkedEntry = (stored, incoming) => {
  const parsed = storedEntrySchema.safeParse(stored);
  if (!parsed.success) return false;
  const item = parsed.data;
  if (item.id === incoming.id) return true;
  return (item.kind === 'issue' || item.kind === 'pull')
    && item.kind === incoming.kind
    && item.number !== undefined
    && Number.isFinite(item.number) && Number.isFinite(incoming.number)
    && item.number === incoming.number
    && normalizedThreadUrl(item.url) === normalizedThreadUrl(incoming.url);
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

  let next = current;
  for (const entry of entries) {
    next = next.filter((item) => !isSameLinkedEntry(item, entry));
    if (linked) next = [...next, entry];
  }
  if (next === current || JSON.stringify(next) === JSON.stringify(current)) return null;
  return { openchamber: { linked_issues: next } };
};
