import { z } from 'zod';

import { getSafeStorage } from '@/stores/utils/safeStorage';

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

type StoredChip = z.infer<typeof storedChipSchema>;

const storedChipsOf = (drafts: ReadonlyMap<string, readonly ComposerReference[]>): Map<string, StoredChip[]> => {
  const kept = new Map<string, StoredChip[]>();
  for (const [key, references] of drafts) {
    const chips = references.flatMap((reference) => (reference.kind === 'shared-page' && reference.receivedId
      ? [{ shareKey: reference.shareKey, receivedId: reference.receivedId, host: reference.host, title: reference.title, link: reference.link }]
      : []));
    if (chips.length > 0) kept.set(key, chips);
  }
  return kept;
};

const serializeStoredChips = (chips: ReadonlyMap<string, readonly StoredChip[]>): string | null => {
  if (chips.size === 0) return null;
  return JSON.stringify({ version: 1, drafts: Object.fromEntries([...chips].slice(-MAX_DRAFTS)) });
};

export function serializeSharedPageChips(drafts: ReadonlyMap<string, readonly ComposerReference[]>): string | null {
  return serializeStoredChips(storedChipsOf(drafts));
}

let ownChips = new Map<string, string>();

const chipsByDraft = (chips: ReadonlyMap<string, readonly StoredChip[]>): Map<string, string> => (
  new Map([...chips].map(([key, value]) => [key, JSON.stringify(value)]))
);

export function readStoredSharedPageChips(): Map<string, SharedPageReference[]> {
  const chips = parseSharedPageChips(getSafeStorage().getItem(STORAGE_KEY));
  ownChips = chipsByDraft(storedChipsOf(chips));
  return chips;
}

export function storeSharedPageChips(drafts: ReadonlyMap<string, readonly ComposerReference[]>): void {
  const ours = storedChipsOf(drafts);
  const oursByDraft = chipsByDraft(ours);
  const changed = [...new Set([...ownChips.keys(), ...oursByDraft.keys()])]
    .filter((key) => ownChips.get(key) !== oursByDraft.get(key));
  if (changed.length === 0) return;
  ownChips = oursByDraft;

  const storage = getSafeStorage();
  const merged = storedChipsOf(parseSharedPageChips(storage.getItem(STORAGE_KEY)));
  for (const key of changed) {
    const chips = ours.get(key);
    merged.delete(key);
    if (chips) merged.set(key, chips);
  }
  const serialized = serializeStoredChips(merged);
  if (serialized === null) storage.removeItem(STORAGE_KEY);
  else storage.setItem(STORAGE_KEY, serialized);
}
