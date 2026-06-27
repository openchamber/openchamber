import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';
import type {
  QuotaCredentialCreate,
  QuotaCredentialRecord,
  QuotaCredentialUpdate,
  QuotaProviderId,
} from '@/types/quota';

type CapturedCall = {
  input: string | URL | Request;
  init?: RuntimeFetchOptions;
};

const calls: CapturedCall[] = [];

let runtimeFetchImpl: (
  input: string | URL | Request,
  init?: RuntimeFetchOptions,
) => Promise<Response> = async () =>
  new Response('[]', { headers: { 'Content-Type': 'application/json' } });

const runtimeFetchMock = async (
  input: string | URL | Request,
  init?: RuntimeFetchOptions,
): Promise<Response> => {
  calls.push({ input, init });
  return runtimeFetchImpl(input, init);
};

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

const {
  useCredentialStore,
  selectCredentialsByProvider,
  selectCredentialById,
} = await import('./useCredentialStore');

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

const makeRecord = (
  overrides: Partial<QuotaCredentialRecord> & {
    id: string;
    providerId: QuotaProviderId;
  },
): QuotaCredentialRecord => ({
  label: `label-${overrides.id}`,
  createdAt: 1,
  updatedAt: 1,
  validationStatus: 'untested',
  ...overrides,
});

const openaiRecord = makeRecord({
  id: 'rec-openai',
  providerId: 'openai',
  label: 'OpenAI key',
});
const copilotRecord = makeRecord({
  id: 'rec-copilot',
  providerId: 'github-copilot',
  label: 'Copilot token',
});

const resetState = () =>
  useCredentialStore.setState({ records: [], isLoading: false, error: null });

const bodyOf = (init?: RuntimeFetchOptions): string | null => {
  if (init?.body != null && typeof init.body === 'string') return init.body;
  return null;
};

const expectRejectsWith = async (
  promise: Promise<unknown>,
  message: string,
): Promise<void> => {
  let didThrow = false;
  let thrown: unknown = null;
  try {
    await promise;
  } catch (e) {
    didThrow = true;
    thrown = e;
  }
  expect(didThrow).toBe(true);
  expect(thrown instanceof Error ? thrown.message : String(thrown)).toBe(message);
};

describe('useCredentialStore', () => {
  beforeEach(() => {
    calls.length = 0;
    runtimeFetchImpl = async () => json([]);
    resetState();
  });

  test('fetchCredentials populates records from GET /api/quota/credentials', async () => {
    runtimeFetchImpl = async () => json([openaiRecord, copilotRecord]);

    await useCredentialStore.getState().fetchCredentials();

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe('/api/quota/credentials');
    expect(useCredentialStore.getState().records).toEqual([openaiRecord, copilotRecord]);
    expect(useCredentialStore.getState().isLoading).toBe(false);
    expect(useCredentialStore.getState().error).toBeNull();
  });

  test('fetchCredentials preserves previous records on failure', async () => {
    useCredentialStore.setState({ records: [openaiRecord] });
    runtimeFetchImpl = async () => json({ error: 'server down' }, { status: 500 });

    await useCredentialStore.getState().fetchCredentials();

    expect(useCredentialStore.getState().records).toEqual([openaiRecord]);
    expect(useCredentialStore.getState().isLoading).toBe(false);
    expect(useCredentialStore.getState().error).toBe('server down');
  });

  test('addCredential POSTs body and stores only the sanitized record', async () => {
    const created = makeRecord({
      id: 'rec-new',
      providerId: 'openai',
      label: 'new key',
    });
    runtimeFetchImpl = async (_input, init) => {
      expect(init?.method).toBe('POST');
      expect(bodyOf(init)).toBe(
        JSON.stringify({
          providerId: 'openai',
          label: 'new key',
          credential: { token: 'sk-secret' },
        }),
      );
      return json(created);
    };

    const input: QuotaCredentialCreate = {
      providerId: 'openai',
      label: 'new key',
      credential: { token: 'sk-secret' },
    };
    const result = await useCredentialStore.getState().addCredential(input);

    expect(result).toEqual(created);
    expect(useCredentialStore.getState().records).toEqual([created]);
    // The raw secret must never leak into store state.
    expect(JSON.stringify(useCredentialStore.getState())).not.toContain('sk-secret');
  });

  test('addCredential preserves previous records on failure', async () => {
    useCredentialStore.setState({ records: [openaiRecord] });
    runtimeFetchImpl = async () => json({ error: 'bad request' }, { status: 400 });

    await expectRejectsWith(
      useCredentialStore.getState().addCredential({
        providerId: 'openai',
        label: 'x',
        credential: {},
      }),
      'bad request',
    );

    expect(useCredentialStore.getState().records).toEqual([openaiRecord]);
    expect(useCredentialStore.getState().error).toBe('bad request');
  });

  test('updateCredential PATCHes and replaces the record in place', async () => {
    useCredentialStore.setState({ records: [openaiRecord, copilotRecord] });
    const updated: QuotaCredentialRecord = {
      ...openaiRecord,
      label: 'renamed',
      updatedAt: 5,
    };
    runtimeFetchImpl = async (input, init) => {
      expect(init?.method).toBe('PATCH');
      expect(String(input)).toBe('/api/quota/credentials/rec-openai');
      return json(updated);
    };

    const input: QuotaCredentialUpdate = { label: 'renamed' };
    const result = await useCredentialStore.getState().updateCredential('rec-openai', input);

    expect(result).toEqual(updated);
    expect(useCredentialStore.getState().records).toEqual([updated, copilotRecord]);
  });

  test('updateCredential preserves previous records on failure', async () => {
    useCredentialStore.setState({ records: [openaiRecord] });
    runtimeFetchImpl = async () => json({ error: 'conflict' }, { status: 409 });

    await expectRejectsWith(
      useCredentialStore.getState().updateCredential('rec-openai', { label: 'x' }),
      'conflict',
    );

    expect(useCredentialStore.getState().records).toEqual([openaiRecord]);
    expect(useCredentialStore.getState().error).toBe('conflict');
  });

  test('deleteCredential removes the record via DELETE', async () => {
    useCredentialStore.setState({ records: [openaiRecord, copilotRecord] });
    runtimeFetchImpl = async (input, init) => {
      expect(init?.method).toBe('DELETE');
      expect(String(input)).toBe('/api/quota/credentials/rec-openai');
      return json({ ok: true });
    };

    await useCredentialStore.getState().deleteCredential('rec-openai');

    expect(useCredentialStore.getState().records).toEqual([copilotRecord]);
    expect(useCredentialStore.getState().error).toBeNull();
  });

  test('deleteCredential preserves previous records on failure', async () => {
    useCredentialStore.setState({ records: [openaiRecord] });
    runtimeFetchImpl = async () => json({ error: 'nope' }, { status: 500 });

    await expectRejectsWith(
      useCredentialStore.getState().deleteCredential('rec-openai'),
      'nope',
    );

    expect(useCredentialStore.getState().records).toEqual([openaiRecord]);
    expect(useCredentialStore.getState().error).toBe('nope');
  });

  test('validateCredential updates validationStatus and returns the result', async () => {
    useCredentialStore.setState({ records: [openaiRecord] });
    runtimeFetchImpl = async (input, init) => {
      expect(init?.method).toBe('POST');
      expect(String(input)).toBe('/api/quota/credentials/rec-openai/validate');
      return json({ valid: true });
    };

    const result = await useCredentialStore.getState().validateCredential('rec-openai');

    expect(result).toEqual({ valid: true });
    const stored = useCredentialStore.getState().records[0];
    expect(stored?.validationStatus).toBe('valid');
    expect(typeof stored?.lastValidatedAt).toBe('number');
    expect(useCredentialStore.getState().error).toBeNull();
  });

  test('validateCredential marks invalid without setting error', async () => {
    useCredentialStore.setState({ records: [openaiRecord] });
    runtimeFetchImpl = async () => json({ valid: false, error: 'expired token' });

    const result = await useCredentialStore.getState().validateCredential('rec-openai');

    expect(result).toEqual({ valid: false, error: 'expired token' });
    expect(useCredentialStore.getState().records[0]?.validationStatus).toBe('invalid');
    // valid:false is an outcome, not a fetch error.
    expect(useCredentialStore.getState().error).toBeNull();
  });

  test('validateCredential preserves records and sets error on HTTP failure', async () => {
    useCredentialStore.setState({ records: [openaiRecord] });
    runtimeFetchImpl = async () => json({ error: 'rate limited' }, { status: 429 });

    await expectRejectsWith(
      useCredentialStore.getState().validateCredential('rec-openai'),
      'rate limited',
    );

    expect(useCredentialStore.getState().records).toEqual([openaiRecord]);
    expect(useCredentialStore.getState().error).toBe('rate limited');
  });

  test('discoverLegacyCredentials returns discovered file on success', async () => {
    runtimeFetchImpl = async (input) => {
      expect(String(input)).toBe('/api/quota/credentials/legacy/openai');
      return json({ filePath: '/home/.config/opencode/auth.json', timestamp: 12345 });
    };

    const result = await useCredentialStore.getState().discoverLegacyCredentials('openai');

    expect(result).toEqual({
      filePath: '/home/.config/opencode/auth.json',
      timestamp: 12345,
    });
  });

  test('discoverLegacyCredentials returns null on 404 and on network failure', async () => {
    runtimeFetchImpl = async () => json({ error: 'not found' }, { status: 404 });
    expect(await useCredentialStore.getState().discoverLegacyCredentials('openai')).toBeNull();

    runtimeFetchImpl = async () => {
      throw new Error('network down');
    };
    expect(await useCredentialStore.getState().discoverLegacyCredentials('openai')).toBeNull();
  });

  describe('selectors', () => {
    beforeEach(() => {
      useCredentialStore.setState({ records: [openaiRecord, copilotRecord] });
    });

    test('selectCredentialsByProvider returns only the matching provider slice', () => {
      const state = useCredentialStore.getState();

      expect(selectCredentialsByProvider(state, 'openai')).toEqual([openaiRecord]);
      expect(selectCredentialsByProvider(state, 'github-copilot')).toEqual([copilotRecord]);
      expect(selectCredentialsByProvider(state, 'claude')).toEqual([]);
    });

    test('selectCredentialById returns the matching record by reference', () => {
      const state = useCredentialStore.getState();

      expect(selectCredentialById(state, 'rec-openai')).toBe(openaiRecord);
      expect(selectCredentialById(state, 'missing')).toBe(undefined);
    });
  });
});
