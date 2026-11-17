import { z } from 'zod';

import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

import { unopenedPageAgentText } from '../sharePages/received/pageText';

import type { ComposerReference } from './composerReferences';


type SharedPageReference = Extract<ComposerReference, { kind: 'shared-page' }>;

const STORAGE_KEY = 'openchamber.sharedPageChips.v1';
const MAX_DRAFTS = 50;

const storedChipSchema = z.object({
  shareKey: z.string().min(1),
  receivedId: z.string().min(1),
  host: z.string(),
  title: z.string().nullable(),
  link: z.string().optional(),
});

const envelopeSchema = z.object({
  version: z.literal(1),
  drafts: z.record(z.string(), z.array(z.unknown())),
});

const readJson = (raw: string | null) => {
  try {
    return JSON.parse(raw ?? 'null');
  } catch {
    return null;
  }
};

export function parseSharedPageChips(raw: string | null): Map<string, SharedPageReference[]> {
  const drafts = new Map<string, SharedPageReference[]>();
  const envelope = envelopeSchema.safeParse(readJson(raw));
  if (!envelope.success) return drafts;
  for (const [key, entries] of Object.entries(envelope.data.drafts)) {
    const chips = entries.flatMap((entry) => {
      const chip = storedChipSchema.safeParse(entry);
      if (!chip.success) return [];
      return [{ kind: 'shared-page' as const, ...chip.data, opened: false, contextText: unopenedPageAgentText(chip.data.host) }];
    });
    if (chips.length > 0) drafts.set(key, chips);
  }
  return drafts;
}

export function serializeSharedPageChips(drafts: ReadonlyMap<string, readonly ComposerReference[]>): string | null {
  const kept: [string, z.infer<typeof storedChipSchema>[]][] = [];
  for (const [key, references] of drafts) {
    const chips = references.flatMap((reference) => (reference.kind === 'shared-page' && reference.receivedId
      ? [{ shareKey: reference.shareKey, receivedId: reference.receivedId, host: reference.host, title: reference.title, link: reference.link }]
      : []));
    if (chips.length > 0) kept.push([key, chips]);
  }
  if (kept.length === 0) return null;
  return JSON.stringify({ version: 1, drafts: Object.fromEntries(kept.slice(-MAX_DRAFTS)) });
}

export function readStoredSharedPageChips(): Map<string, SharedPageReference[]> {
  return parseSharedPageChips(getDeferredSafeStorage().getItem(STORAGE_KEY));
}

let lastWritten: string | null | undefined;

export function storeSharedPageChips(drafts: ReadonlyMap<string, readonly ComposerReference[]>): void {
  const serialized = serializeSharedPageChips(drafts);
  if (serialized === lastWritten) return;
  lastWritten = serialized;
  const storage = getDeferredSafeStorage();
  if (serialized === null) storage.removeItem(STORAGE_KEY);
  else storage.setItem(STORAGE_KEY, serialized);
}
