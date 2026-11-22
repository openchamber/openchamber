import { describe, expect, test } from 'bun:test';
import { migratePersistedDrafts, persistedDraftEnvelopeSchema } from './useInlineCommentDraftStore';

const draft = (provider?: string) => {
  const base = {
  id: `icd-${provider ?? 'none'}`,
  sessionKey: 's1',
  source: 'pr-comment',
  fileLabel: '#7 @octo',
  startLine: 0,
  endLine: 0,
  code: 'the comment',
  language: 'markdown',
  text: '',
  createdAt: 1,
  };
  return provider ? { ...base, provider } : base;
};

const read = (bucket: unknown[]) => migratePersistedDrafts(persistedDraftEnvelopeSchema.safeParse({ drafts: { key: bucket } }), 3);

describe('persisted draft provider', () => {
  test('keeps any served provider id, old and new, and a draft that names none', () => {
    const drafts = [draft('github'), draft('gitlab'), draft('acme'), draft()];
    expect(read(drafts).drafts.key).toEqual(drafts);
  });

  test('drops only the draft whose provider is malformed', () => {
    expect(read([draft('Bad Id'), draft('acme')]).drafts.key?.map((entry) => entry.provider)).toEqual(['acme']);
  });
});
