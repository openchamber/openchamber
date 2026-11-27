import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { GUEST_ATTACH_URL_MAX } from '@openchamber/sdk';
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

const extensionOwnerSchema = z.object({ sessionId: z.string(), storageId: z.string() });
type ExtensionLinkOwner = z.infer<typeof extensionOwnerSchema>;
const httpUrl = z.url({ protocol: /^https?$/ }).trim().max(GUEST_ATTACH_URL_MAX);
const extensionLinkScope = z.object({
  id: z.string().min(1),
  storageId: z.string().min(1),
  frameDirectory: z.string().trim().min(1).optional(),
});
const extensionLinkOperationSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('link'),
    extension: extensionLinkScope,
    entry: linkedEntrySchema.extend({ kind: z.literal('guest'), identifier: z.string().min(1), url: httpUrl }),
  }),
  z.object({
    operation: z.literal('unlink'),
    extension: extensionLinkScope,
    url: httpUrl,
  }),
]);
type ExtensionLinkOperation = z.infer<typeof extensionLinkOperationSchema>;

export const parseExtensionLinkOperation = (payload: SessionPayload) => extensionLinkOperationSchema.safeParse(payload);

export const withoutExtensionLinkOwner = ({ extensionLinkOwner: _owner, ...entry }: SessionMetadata) => entry;

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
  return {
    ok: true as const,
    entries: parsed.data.entries.map(({ extensionLinkOwner: _owner, ...entry }) => entry),
    linked: parsed.data.linked,
  };
};

const normalizedThreadUrl = (url: string | undefined) => {
  if (url === undefined) throw new TypeError("Cannot read properties of undefined (reading 'trim')");
  return url.trim().replace(/\/+$/, '').toLowerCase();
};

const linkListSchema = z.looseObject({ linked_issues: z.array(z.unknown()) });
const linkedIssuesSchema = z.looseObject({
  openchamber: linkListSchema.catch({ linked_issues: [] }),
}).catch({ openchamber: { linked_issues: [] } });

const storedEntrySchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  kind: z.string(),
  number: z.number().optional(),
});

const ownedEntrySchema = storedEntrySchema.extend({ extensionLinkOwner: extensionOwnerSchema });
const linkList = (metadata: SessionMetadata | JsonValue | undefined) =>
  linkedIssuesSchema.parse(metadata ?? {}).openchamber.linked_issues;

export const preserveUnchangedLinkOwners = (current: SessionMetadata | undefined, patch: SessionMetadata): SessionMetadata => {
  const openchamber = linkListSchema.safeParse(patch.openchamber);
  if (!openchamber.success) return patch;
  const stored = linkList(current);
  return {
    ...patch,
    openchamber: {
      ...openchamber.data,
      linked_issues: openchamber.data.linked_issues.map((item) => {
        const owned = ownedEntrySchema.safeParse(item);
        return owned.success && !stored.some((entry) => isDeepStrictEqual(entry, item))
          ? withoutExtensionLinkOwner(owned.data)
          : item;
      }),
    },
  };
};

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
  const current = linkList(metadata);

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

const linkAddress = (value: string) => {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
};

export const buildExtensionLinksPatch = (
  metadata: SessionMetadata | undefined,
  request: ExtensionLinkOperation,
  owner: ExtensionLinkOwner,
): LinkedIssuesPatch | null => {
  const current = linkList(metadata);
  const ownedByExtension = (entry: z.infer<typeof storedEntrySchema>) => {
    const parsed = extensionOwnerSchema.safeParse(entry.extensionLinkOwner);
    return entry.kind === 'guest' && parsed.success
      && parsed.data.sessionId === owner.sessionId && parsed.data.storageId === owner.storageId;
  };
  if (request.operation === 'unlink') {
    const address = linkAddress(request.url);
    const next = current.filter((item) => {
      const parsed = storedEntrySchema.safeParse(item);
      return !parsed.success || linkAddress(parsed.data.url) !== address || !ownedByExtension(parsed.data);
    });
    return next.length === current.length ? null : { openchamber: { linked_issues: next } };
  }

  const { entry, extension } = request;
  const id = `guest:${extension.id}:${entry.identifier}`;
  const address = linkAddress(entry.url);
  const matches = current.filter((item) => {
    const parsed = storedEntrySchema.safeParse(item);
    return parsed.success && (parsed.data.id === id || linkAddress(parsed.data.url) === address);
  });
  if (matches.length === 0) {
    const added = { ...entry, id, providerId: extension.id, extensionLinkOwner: owner };
    return { openchamber: { linked_issues: [...current, added] } };
  }
  const [existing] = matches;
  const same = storedEntrySchema.safeParse(existing);
  if (matches.length !== 1 || !same.success || same.data.id !== id || !ownedByExtension(same.data)) return null;
  const refreshed = { ...entry, id, providerId: extension.id, linkedAt: same.data.linkedAt ?? entry.linkedAt, extensionLinkOwner: owner };
  if (isDeepStrictEqual(existing, refreshed)) return null;
  return { openchamber: { linked_issues: current.map((item) => item === existing ? refreshed : item) } };
};
