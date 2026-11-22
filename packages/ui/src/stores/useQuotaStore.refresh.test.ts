import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { ProviderResult, QuotaProviderId } from '@/types';
import { fetchQuota } from '@/lib/quota/fetchQuota';
import { useQuotaStore } from './useQuotaStore';

const result = (providerId: QuotaProviderId = 'claude'): ProviderResult => ({
  providerId, providerName: providerId, ok: true, configured: true, fetchedAt: 123,
  usage: { windows: { session: {
    usedPercent: 42, remainingPercent: 58, windowSeconds: 18000,
    resetAfterSeconds: 100, resetAt: 1000, resetAtFormatted: null, resetAfterFormatted: null,
  } } },
});
const json = (body: ProviderResult) => Response.json(body);
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
const deferredResponse = () => {
  let complete: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>(resolve => { complete = resolve; });
  return { promise, complete: (response: Response) => complete?.(response) };
};

let handleRequest: (url: string, signal?: AbortSignal | null) => Promise<Response>;
const network = spyOn(globalThis, 'fetch');

beforeEach(() => {
  useQuotaStore.getState().resetForRuntimeSwitch();
  handleRequest = async () => json(result());
  network.mockImplementation((input, init) => handleRequest(input.toString(), init?.signal));
});
afterEach(() => {
  useQuotaStore.getState().resetForRuntimeSwitch();
  network.mockReset();
});
afterAll(() => network.mockRestore());

describe('quota refresh failure is not empty success', () => {
  test('Mistral console-only status survives response parsing without usage figures', async () => {
    handleRequest = async url => {
      expect(url).toBe('/api/quota/mistral');
      return Response.json({
        providerId: 'mistral', providerName: 'Mistral AI', ok: true, configured: true,
        usage: { windows: {}, usageAvailability: 'console-only' }, fetchedAt: 123,
      });
    };

    expect(await useQuotaStore.getState().fetchProviderQuota('mistral')).toBe(true);
    expect(useQuotaStore.getState().results[0]).toMatchObject({
      providerId: 'mistral', ok: true, configured: true,
      usage: { windows: {}, usageAvailability: 'console-only' },
    });
    expect(useQuotaStore.getState().results[0]?.usage?.windows).toEqual({});
  });

  test('Mistral rejected credentials stay visible as an unauthorized provider result', async () => {
    handleRequest = async () => Response.json({
      providerId: 'mistral', providerName: 'Mistral AI', ok: false, configured: true,
      error: 'Invalid or revoked API key — Mistral rejected the enrolled credential',
      usage: null, fetchedAt: 123,
    });

    expect(await useQuotaStore.getState().fetchProviderQuota('mistral')).toBe(true);
    expect(useQuotaStore.getState().results[0]).toMatchObject({
      providerId: 'mistral', configured: true, ok: false,
      error: 'Invalid or revoked API key — Mistral rejected the enrolled credential',
      usage: null,
    });
  });

  test('keeps the exact previous snapshot, configuration and timestamp on network failure', async () => {
    await useQuotaStore.getState().fetchQuotas(['claude']);
    const before = useQuotaStore.getState();
    handleRequest = async () => { throw new Error('network down'); };
    expect(await useQuotaStore.getState().fetchQuotas(['claude'])).toBe(false);
    const after = useQuotaStore.getState();
    expect(after.results).toBe(before.results);
    expect(after.results[0].configured).toBe(true);
    expect(after.results[0].usage?.windows.session.usedPercent).toBe(42);
    expect(after.lastUpdated).toBe(before.lastUpdated);
    expect(after.refreshErrors.claude).toBe('network down');
    expect(after.isLoading).toBe(false);
  });

  test('a first-load failure leaves provider configuration unknown', async () => {
    handleRequest = async () => { throw new Error('offline'); };
    await useQuotaStore.getState().fetchProviderQuota('claude');
    expect(useQuotaStore.getState().results).toEqual([]);
    expect(useQuotaStore.getState().refreshErrors.claude).toBe('offline');
    expect(useQuotaStore.getState().lastUpdated).toBeNull();
  });

  test('another provider succeeding does not clear a failed provider or its error', async () => {
    await useQuotaStore.getState().fetchProviderQuota('claude');
    handleRequest = async url => {
      if (url.endsWith('/claude')) throw new Error('claude unreachable');
      await pause();
      return json(result('codex'));
    };
    expect(await useQuotaStore.getState().fetchQuotas(['claude', 'codex'])).toBe(true);
    expect(useQuotaStore.getState().results).toHaveLength(2);
    expect(useQuotaStore.getState().refreshErrors).toEqual({ claude: 'claude unreachable' });
    expect(useQuotaStore.getState().error).toBe('claude unreachable');
    handleRequest = async () => json(result());
    await useQuotaStore.getState().fetchProviderQuota('claude');
    expect(useQuotaStore.getState().refreshErrors).toEqual({});
    expect(useQuotaStore.getState().error).toBeNull();
  });

  test('concurrent refreshes share one provider request', async () => {
    const reply = deferredResponse();
    handleRequest = () => reply.promise;
    const first = useQuotaStore.getState().fetchProviderQuota('claude');
    const second = useQuotaStore.getState().fetchProviderQuota('claude');
    await pause();
    expect(network.mock.calls).toHaveLength(1);
    expect(useQuotaStore.getState().isLoading).toBe(true);
    reply.complete(json(result()));
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(useQuotaStore.getState().isLoading).toBe(false);
  });

  test('a runtime reset aborts old work without clearing the new request or its loading state', async () => {
    const oldReply = deferredResponse();
    let oldSignal: AbortSignal | null | undefined;
    handleRequest = (_url, signal) => { oldSignal = signal; return oldReply.promise; };
    const old = useQuotaStore.getState().fetchProviderQuota('claude');
    await pause();
    useQuotaStore.getState().resetForRuntimeSwitch();
    const newReply = deferredResponse();
    handleRequest = () => newReply.promise;
    const current = useQuotaStore.getState().fetchProviderQuota('claude');
    expect(await old).toBe(false);
    expect(oldSignal?.aborted).toBe(true);
    expect(useQuotaStore.getState().isLoading).toBe(true);
    oldReply.complete(json(result()));
    await pause();
    expect(useQuotaStore.getState().results).toEqual([]);
    newReply.complete(json({ ...result(), fetchedAt: 456 }));
    expect(await current).toBe(true);
    expect(useQuotaStore.getState().results[0].fetchedAt).toBe(456);
    expect(useQuotaStore.getState().refreshErrors).toEqual({});
  });

  test('malformed success payloads preserve previous data', async () => {
    await useQuotaStore.getState().fetchProviderQuota('claude');
    const previous = useQuotaStore.getState().results;
    for (const payload of [null, {}, result('codex')]) {
      handleRequest = async () => Response.json(payload);
      expect(await useQuotaStore.getState().fetchProviderQuota('claude')).toBe(false);
      expect(useQuotaStore.getState().results).toBe(previous);
    }
  });

  test('authoritative unconfigured success replaces old configuration', async () => {
    await useQuotaStore.getState().fetchProviderQuota('claude');
    handleRequest = async () => json({ ...result(), configured: false, usage: null });
    expect(await useQuotaStore.getState().fetchProviderQuota('claude')).toBe(true);
    expect(useQuotaStore.getState().results[0].configured).toBe(false);
    expect(useQuotaStore.getState().results[0].usage).toBeNull();
  });

  test('a provider failure reported inside HTTP 200 also preserves the last usage sample', async () => {
    await useQuotaStore.getState().fetchProviderQuota('claude');
    const before = useQuotaStore.getState();
    handleRequest = async () => json({ ...result(), ok: false, usage: null, error: 'Provider API unavailable', fetchedAt: 456 });
    // The instance answered, even though its provider did not.
    expect(await useQuotaStore.getState().fetchProviderQuota('claude')).toBe(true);
    expect(useQuotaStore.getState().results).toBe(before.results);
    expect(useQuotaStore.getState().lastUpdated).toBe(before.lastUpdated);
    expect(useQuotaStore.getState().refreshErrors.claude).toBe('Provider API unavailable');
  });
});

describe('per-credential quota results', () => {
  test('two stored credentials produce two labeled results for one provider', async () => {
    handleRequest = async () => Response.json([
      { ...result('codex'), credentialId: 'cred_main', credentialLabel: 'Main', credentialActive: true, accountLabel: 'main@example.com' },
      { ...result('codex'), credentialId: 'cred_second', credentialLabel: 'Second', credentialActive: false },
    ]);
    expect(await useQuotaStore.getState().fetchProviderQuota('codex')).toBe(true);
    const entries = useQuotaStore.getState().results.filter((entry) => entry.providerId === 'codex');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ credentialId: 'cred_main', credentialLabel: 'Main', credentialActive: true, accountLabel: 'main@example.com' });
    expect(entries[1]).toMatchObject({ credentialId: 'cred_second', credentialLabel: 'Second', credentialActive: false });
    expect(useQuotaStore.getState().refreshErrors).toEqual({});
  });

  test('one failing credential keeps the other credential sample and surfaces its error', async () => {
    handleRequest = async () => Response.json([
      { ...result('codex'), credentialId: 'cred_main', credentialActive: true },
      { ...result('codex'), credentialId: 'cred_second', credentialActive: false, ok: false, usage: null, error: 'Second account rejected' },
    ]);
    expect(await useQuotaStore.getState().fetchProviderQuota('codex')).toBe(true);
    const entries = useQuotaStore.getState().results.filter((entry) => entry.providerId === 'codex');
    expect(entries).toHaveLength(2);
    expect(entries[0].usage?.windows.session.usedPercent).toBe(42);
    expect(useQuotaStore.getState().refreshErrors.codex).toBe('Second account rejected');
  });
});

describe('quota request deadline', () => {
  test('bounds a transport that never returns headers, even if it ignores abort', async () => {
    let signal: AbortSignal | null | undefined;
    const pending = deferredResponse();
    handleRequest = (_url, nextSignal) => { signal = nextSignal; return pending.promise; };
    await expect(fetchQuota('claude', { timeoutMs: 15 })).rejects.toThrow('Quota request timed out');
    expect(signal?.aborted).toBe(true);
    pending.complete(json(result()));
  });

  test('the deadline includes an unfinished JSON response body', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    handleRequest = async () => new Response(new ReadableStream<Uint8Array>({ start(next) { controller = next; } }));
    await expect(fetchQuota('claude', { timeoutMs: 15 })).rejects.toThrow('Quota request timed out');
    controller?.error(new Error('fixture cleanup'));
  });

  test('a pre-aborted request never reaches the network', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchQuota('claude', { signal: controller.signal })).rejects.toThrow('aborted');
    expect(network.mock.calls).toHaveLength(0);
  });
});
