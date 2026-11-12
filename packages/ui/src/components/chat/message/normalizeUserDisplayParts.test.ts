import { describe, expect, test } from 'bun:test';
import type { Part } from '@/lib/opencode/model';
import { CONTEXT_METADATA_KEY, type ContextPartPayload } from '@/lib/messages/contextParts';
import { unknownProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import { gitlabLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { normalizeUserDisplayParts } from './normalizeUserDisplayParts';

// SAFETY: a synthetic context part as the composer builds it; normalization
// reads only its identity, type, text and metadata.
const contextPart = (payload: ContextPartPayload): Part => ({
  id: 'prt_1',
  sessionID: 'ses_1',
  messageID: 'msg_1',
  type: 'text',
  text: 'context',
  synthetic: true,
  metadata: { [CONTEXT_METADATA_KEY]: payload },
} as Part);

const filenameOf = (parts: Part[]): string | undefined => {
  const [part] = parts;
  return part?.type === 'file' ? part.filename : undefined;
};

const generic = (id: string | null | undefined) => unknownProviderDescriptor(id ?? '');

describe('normalizeUserDisplayParts', () => {
  test('labels a change-request chip by the provider the lookup holds', () => {
    const gitlab = gitlabLikeDescriptor();
    const parts = [contextPart({ kind: 'change-request', provider: gitlab.id, number: 12, title: 'Fix login', url: 'https://gitlab.com/g/r/-/merge_requests/12' })];
    // The generic wording stands until the provider list arrives; the chip is
    // drawn again with the lookup that holds it.
    expect(filenameOf(normalizeUserDisplayParts(parts, generic))).toBe('PR #12: Fix login');
    expect(filenameOf(normalizeUserDisplayParts(parts, (id) => (id === gitlab.id ? gitlab : unknownProviderDescriptor(id ?? ''))))).toBe('!12: Fix login');
  });
});
