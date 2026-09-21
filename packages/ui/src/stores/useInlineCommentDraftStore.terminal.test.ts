import { afterEach, describe, expect, test } from 'bun:test';
import { migratePersistedDrafts, persistedDraftEnvelopeSchema, useInlineCommentDraftStore } from './useInlineCommentDraftStore';

const selection = {
  source: 'terminal' as const,
  fileLabel: 'Terminal 1',
  startLine: 4,
  endLine: 5,
  code: 'first\nsecond',
  language: '',
  terminalId: 'term-1',
  text: '',
};
const target = { directory: '/repo', sessionKey: 'session-1' };

describe('terminal context drafts', () => {
  afterEach(() => { useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} }); });

  test('persists snapshots by chat session and deduplicates identical selections', () => {
    useInlineCommentDraftStore.getState().addDraft(target, selection);
    useInlineCommentDraftStore.getState().addDraft(target, selection);
    const drafts = useInlineCommentDraftStore.getState().getDrafts(target);
    expect(drafts).toHaveLength(1);
    expect({ ...drafts[0], id: undefined, createdAt: undefined }).toEqual({ ...selection, sessionKey: 'session-1', id: undefined, createdAt: undefined });
  });

  test('supports individual removal and ordered consume', () => {
    useInlineCommentDraftStore.getState().addDraft(target, selection);
    useInlineCommentDraftStore.getState().addDraft(target, { ...selection, startLine: 8, endLine: 8, code: 'third' });
    const drafts = useInlineCommentDraftStore.getState().getDrafts(target);
    useInlineCommentDraftStore.getState().removeDraft(target, drafts[0].id);
    expect(useInlineCommentDraftStore.getState().consumeDrafts(target)).toHaveLength(1);
    expect(useInlineCommentDraftStore.getState().getDrafts(target)).toEqual([]);
  });

  test('restores consumed drafts after a failed send without duplicating them', () => {
    useInlineCommentDraftStore.getState().addDraft(target, selection);
    const consumed = useInlineCommentDraftStore.getState().consumeDrafts(target);
    useInlineCommentDraftStore.getState().restoreDrafts(target, consumed);
    useInlineCommentDraftStore.getState().restoreDrafts(target, consumed);
    expect(useInlineCommentDraftStore.getState().getDrafts(target)).toEqual(consumed);
  });

  test('isolates identical session IDs by normalized directory', () => {
    const otherTarget = { directory: '/other', sessionKey: 'session-1' };
    useInlineCommentDraftStore.getState().addDraft(target, selection);
    useInlineCommentDraftStore.getState().addDraft(otherTarget, { ...selection, code: 'other' });

    useInlineCommentDraftStore.getState().clearDrafts({ ...target, directory: '/repo/' });

    expect(useInlineCommentDraftStore.getState().getDrafts(target)).toEqual([]);
    expect(useInlineCommentDraftStore.getState().getDrafts(otherTarget)).toHaveLength(1);
  });

  test('returns a stable empty snapshot for absent draft buckets', () => {
    const first = useInlineCommentDraftStore.getState().getDrafts(target);
    const second = useInlineCommentDraftStore.getState().getDrafts(target);

    expect(first).toBe(second);
  });

  test('updates one draft without serializing the complete envelope on the mutation path', () => {
    useInlineCommentDraftStore.getState().addDraft(target, selection);
    const draft = useInlineCommentDraftStore.getState().getDrafts(target)[0];
    const originalStringify = JSON.stringify;
    let envelopeSerializations = 0;
    JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
      if (value && typeof value === 'object' && 'drafts' in value && 'touchedAt' in value) {
        envelopeSerializations += 1;
      }
      return originalStringify(value, ...(rest as [Parameters<typeof JSON.stringify>[1], Parameters<typeof JSON.stringify>[2]]));
    }) as typeof JSON.stringify;

    try {
      useInlineCommentDraftStore.getState().updateDraft(target, draft.id, { text: 'edited' });
      expect(envelopeSerializations).toBe(0);
      expect(useInlineCommentDraftStore.getState().getDrafts(target)[0]?.text).toBe('edited');
    } finally {
      JSON.stringify = originalStringify;
    }
  });
});

describe('persisted draft migration', () => {
  type PersistedV2Draft = {
    id: string;
    sessionKey: string;
    source: string;
    fileLabel: string;
    startLine: number;
    endLine: number;
    code: string;
    language: string;
    text: string;
    createdAt: number;
  };
  const v2Draft = (overrides: Partial<PersistedV2Draft> = {}): PersistedV2Draft => ({
    id: 'icd-1',
    sessionKey: 'session-1',
    source: 'diff',
    fileLabel: 'src/app.ts',
    startLine: 3,
    endLine: 5,
    code: 'const x = 1;',
    language: 'ts',
    text: 'fix this',
    createdAt: 1000,
    ...overrides,
  });

  test('moves the terminal id out of the language field', () => {
    const migrated = migratePersistedDrafts(persistedDraftEnvelopeSchema.safeParse({
      drafts: { key: [v2Draft({ source: 'terminal', language: 'term-9' })] },
      touchedAt: { key: 1000 },
    }), 2);
    expect(migrated.drafts.key[0].terminalId).toBe('term-9');
    expect(migrated.drafts.key[0].language).toBe('');
    expect(migrated.touchedAt.key).toBe(1000);
  });

  test('drops preview-console drafts but keeps the rest of the bucket', () => {
    const migrated = migratePersistedDrafts(persistedDraftEnvelopeSchema.safeParse({
      drafts: { key: [v2Draft({ source: 'preview-console' }), v2Draft({ id: 'icd-2' })] },
      touchedAt: { key: 1000 },
    }), 2);
    expect(migrated.drafts.key.map((draft) => draft.id)).toEqual(['icd-2']);
  });

  test('malformed entries and unknown payload shapes reset safely', () => {
    expect(migratePersistedDrafts(persistedDraftEnvelopeSchema.safeParse(null), 2)).toEqual({ drafts: {}, touchedAt: {} });
    expect(migratePersistedDrafts(persistedDraftEnvelopeSchema.safeParse({ drafts: 'nope' }), 2)).toEqual({ drafts: {}, touchedAt: {} });
    const migrated = migratePersistedDrafts(persistedDraftEnvelopeSchema.safeParse({
      drafts: { key: [{ id: 42 }, v2Draft()] },
      touchedAt: {},
    }), 2);
    expect(migrated.drafts.key).toHaveLength(1);
  });

  test('pre-v2 payloads reset entirely', () => {
    expect(migratePersistedDrafts(persistedDraftEnvelopeSchema.safeParse({ drafts: { key: [v2Draft()] }, touchedAt: {} }), 1))
      .toEqual({ drafts: {}, touchedAt: {} });
  });
});
