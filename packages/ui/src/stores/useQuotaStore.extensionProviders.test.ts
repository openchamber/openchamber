import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { ProviderResult, QuotaProviderId } from '@/types';
import { QUOTA_PROVIDERS } from '@/lib/quota/providers';
import type { ExtensionQuotaProvider } from '@/lib/quota/extensionProviders';
import { useQuotaStore } from './useQuotaStore';

const TEAPOT = { id: 'ext-teapot-usage' as const, name: 'Teapot Usage', icon: 'cup', guestId: 'teapot-usage' };
const GARBAGE = { id: 'ext-garbage-usage' as const, name: 'Garbage Usage', icon: 'flask', guestId: 'garbage-usage' };

const result = (providerId: string): ProviderResult => ({
  // SAFETY: the ids this test asks for are built-in ids and the `ext-` ids of its two fake extensions.
  providerId: providerId as QuotaProviderId, providerName: providerId, ok: true, configured: true, fetchedAt: 123,
  usage: { windows: { '5h': { usedPercent: 24, remainingPercent: 76, windowSeconds: 18000, resetAfterSeconds: 100, resetAt: 1000, resetAtFormatted: null, resetAfterFormatted: null } } },
});

/** What the fake server lists, or `down` while it cannot answer. */
let extensions: ExtensionQuotaProvider[] | 'down' = [];
const requested: string[] = [];
const network = spyOn(globalThis, 'fetch');
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  useQuotaStore.getState().resetForRuntimeSwitch();
  extensions = [];
  requested.length = 0;
  network.mockImplementation(async (input) => {
    const url = input.toString();
    requested.push(url);
    if (url.endsWith('/api/quota/extensions')) {
      if (extensions === 'down') return new Response('{"error":"Failed"}', { status: 500 });
      return Response.json({ extensions });
    }
    // The path's last segment is the id the store asked for; `fetchQuota` checks the echo itself.
    const providerId = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    return Response.json(result(providerId));
  });
});
afterEach(() => {
  useQuotaStore.getState().resetForRuntimeSwitch();
  network.mockReset();
});
afterAll(() => network.mockRestore());

const fetchedQuotas = () => requested.filter((url) => url.includes('/api/quota/') && !url.endsWith('/extensions'));

describe('the extensions\' usage providers in the quota store', () => {
  test('reads the list, draws it after the built-ins, and shows it in Work Status by default like a built-in', async () => {
    extensions = [TEAPOT];
    await useQuotaStore.getState().loadExtensionProviders();
    const state = useQuotaStore.getState();
    expect(state.extensionProviders).toEqual([TEAPOT]);
    expect(state.dropdownProviderIds).toEqual([...QUOTA_PROVIDERS.map((provider) => provider.id), TEAPOT.id]);
    // Nothing loaded yet: the newcomer waits for the instance load, which fetches the whole list.
    expect(fetchedQuotas()).toEqual([]);
  });

  test('fetches a provider that arrives once the instance has loaded, and forgets one that leaves', async () => {
    await useQuotaStore.getState().fetchQuotas(['claude']);
    extensions = [TEAPOT, GARBAGE];
    await useQuotaStore.getState().loadExtensionProviders();
    await pause();
    expect(fetchedQuotas().filter((url) => url.includes('ext-')).map((url) => url.slice(url.indexOf('/api/quota/')))).toEqual(['/api/quota/ext-teapot-usage', '/api/quota/ext-garbage-usage']);
    expect(useQuotaStore.getState().results.map((entry) => entry.providerId)).toEqual(['claude', TEAPOT.id, GARBAGE.id]);
    useQuotaStore.getState().setSelectedProvider(GARBAGE.id);

    // Paused or removed: its card, result and selection go at once; the other extension's stay.
    extensions = [TEAPOT];
    await useQuotaStore.getState().loadExtensionProviders();
    const state = useQuotaStore.getState();
    expect(state.extensionProviders).toEqual([TEAPOT]);
    expect(state.results.map((entry) => entry.providerId)).toEqual(['claude', TEAPOT.id]);
    expect(state.selectedProviderId).toBeNull();
    expect(state.dropdownProviderIds).not.toContain(GARBAGE.id);
    // An unchanged list changes nothing.
    const before = useQuotaStore.getState().extensionProviders;
    await useQuotaStore.getState().loadExtensionProviders();
    expect(useQuotaStore.getState().extensionProviders).toBe(before);
  });

  test('changing the Work Status list while an extension is paused keeps its choice', async () => {
    extensions = [TEAPOT];
    await useQuotaStore.getState().loadExtensionProviders();
    useQuotaStore.setState({ savedDropdownProviderIds: ['claude', 'codex', TEAPOT.id] });
    extensions = [];
    await useQuotaStore.getState().loadExtensionProviders();
    expect(useQuotaStore.getState().setProviderInDropdown('codex', false)).toEqual(['claude', TEAPOT.id]);
    extensions = [TEAPOT];
    await useQuotaStore.getState().loadExtensionProviders();
    expect(useQuotaStore.getState().dropdownProviderIds).toEqual(['claude', TEAPOT.id]);
  });

  test('an extension with a very long name stays in the list beside the others', async () => {
    const long = { ...GARBAGE, name: 'G'.repeat(300) };
    extensions = [TEAPOT, long];
    await useQuotaStore.getState().loadExtensionProviders();
    expect(useQuotaStore.getState().extensionProviders).toEqual([TEAPOT, long]);
  });

  test('a saved Work Status list is narrowed to the providers known now and widens when they come back', async () => {
    extensions = [TEAPOT];
    await useQuotaStore.getState().loadExtensionProviders();
    // The user unticks every built-in but Claude on the Usage page; the extension's card stays ticked.
    useQuotaStore.setState({ savedDropdownProviderIds: ['claude', 'codex', TEAPOT.id] });
    useQuotaStore.getState().setProviderInDropdown('codex', false);
    expect(useQuotaStore.getState().dropdownProviderIds).toEqual(['claude', TEAPOT.id]);
    // Paused: the saved choice is kept and the list shown is narrowed to what exists now.
    extensions = [];
    await useQuotaStore.getState().loadExtensionProviders();
    expect(useQuotaStore.getState().dropdownProviderIds).toEqual(['claude']);
    extensions = [TEAPOT];
    await useQuotaStore.getState().loadExtensionProviders();
    expect(useQuotaStore.getState().dropdownProviderIds).toEqual(['claude', TEAPOT.id]);
    expect(useQuotaStore.getState().savedDropdownProviderIds).toEqual(['claude', TEAPOT.id]);
  });

  test('a failed read keeps the list it had, and a read asked during another is answered by one more read', async () => {
    extensions = [TEAPOT];
    await useQuotaStore.getState().loadExtensionProviders();
    extensions = 'down';
    await useQuotaStore.getState().loadExtensionProviders();
    expect(useQuotaStore.getState().extensionProviders).toEqual([TEAPOT]);
    extensions = [TEAPOT, GARBAGE];
    // The second call joins the read on the wire and asks for one more after it, since that read may predate the change.
    await Promise.all([useQuotaStore.getState().loadExtensionProviders(), useQuotaStore.getState().loadExtensionProviders()]);
    await pause();
    expect(requested.filter((url) => url.endsWith('/api/quota/extensions'))).toHaveLength(4);
    expect(useQuotaStore.getState().extensionProviders).toEqual([TEAPOT, GARBAGE]);
  });

  test('a runtime switch drops the extensions\' providers with everything else', async () => {
    extensions = [TEAPOT];
    await useQuotaStore.getState().loadExtensionProviders();
    useQuotaStore.getState().resetForRuntimeSwitch();
    expect(useQuotaStore.getState().extensionProviders).toEqual([]);
    expect(useQuotaStore.getState().dropdownProviderIds).toEqual(QUOTA_PROVIDERS.map((provider) => provider.id));
  });
});
