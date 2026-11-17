import { z } from 'zod';


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

const linkedIssuesSchema = z.looseObject({
  openchamber: z.looseObject({ linked_issues: z.array(z.unknown()).catch([]) }).catch({ linked_issues: [] }),
}).catch({ openchamber: { linked_issues: [] } });

const storedEntrySchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  kind: z.string(),
  number: z.number().optional(),
});

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
