import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGitIdentitiesStore } from './useGitIdentitiesStore';

const originalResolver = getRuntimeUrlResolver();
const originalFetch = globalThis.fetch;
const author = { id: 'author-one', name: 'Work', userName: 'Author', userEmail: 'author@example.com' };
let savedProfiles = '[]';
let writes: string[] = [];
let failWrite = false;
let pendingProfileRead: Promise<Response> | null = null;
let pendingProfileWrite: Promise<Response> | null = null;
let globalIdentityResponse: { userName: string | null; userEmail: string | null } = { userName: 'System Author', userEmail: 'system@example.com' };

beforeEach(() => {
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://author-profiles.example' });
  useGitIdentitiesStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  savedProfiles = '[]';
  writes = [];
  failWrite = false;
  pendingProfileRead = null;
  pendingProfileWrite = null;
  globalIdentityResponse = { userName: 'System Author', userEmail: 'system@example.com' };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith('/api/git/global-identity')) {
      return Response.json(globalIdentityResponse);
    }
    if (!request.url.endsWith('/api/git/identities') && !request.url.endsWith('/api/git/identities/author-one')) {
      throw new Error('Unexpected request outside author profile routes');
    }
    if (request.method === 'PUT' || request.method === 'POST') {
      const body = await request.text();
      writes.push(body);
      if (failWrite) return Response.json({ error: 'Write rejected' }, { status: 500 });
      if (pendingProfileWrite) return pendingProfileWrite;
      savedProfiles = `[${body}]`;
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    }
    if (pendingProfileRead) return pendingProfileRead;
    return new Response(savedProfiles, { headers: { 'Content-Type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRuntimeUrlResolver(originalResolver);
});

describe('author profile storage', () => {
  test('creates and updates only public author fields', async () => {
    expect(await useGitIdentitiesStore.getState().createProfile(author)).toBe(true);
    expect(JSON.parse(writes[0])).toEqual({ ...author, color: 'keyword', icon: 'branch' });

    expect(await useGitIdentitiesStore.getState().updateProfile(author.id, {
      userName: 'Updated Author',
      signCommits: true,
      signingKey: '/public/signing.pub',
    })).toBe(true);

    expect(JSON.parse(writes[1])).toEqual({
      ...author,
      userName: 'Updated Author',
      signCommits: true,
      signingKey: '/public/signing.pub',
      color: 'keyword',
      icon: 'branch',
    });
  });

  test('rejects a profile response containing a legacy transport field', async () => {
    savedProfiles = JSON.stringify([{ ...author, sshKey: '/private/key' }]);
    expect(await useGitIdentitiesStore.getState().loadProfiles()).toBe(false);
    expect(useGitIdentitiesStore.getState().profiles).toEqual([]);
  });

  test('a rejected edit preserves the stored public profile', async () => {
    useGitIdentitiesStore.setState({ profiles: [author] });
    failWrite = true;

    expect(await useGitIdentitiesStore.getState().updateProfile(author.id, { userName: 'Rejected' })).toBe(false);
    expect(useGitIdentitiesStore.getState().profiles).toEqual([author]);
  });

  test('global Git configuration becomes author data only', async () => {
    expect(await useGitIdentitiesStore.getState().loadGlobalIdentity()).toBe(true);
    useGitIdentitiesStore.getState().setSelectedProfile('global');

    expect(useGitIdentitiesStore.getState().getProfileById('global')).toEqual({
      id: 'global',
      name: 'System Author',
      userName: 'System Author',
      userEmail: 'system@example.com',
      color: 'info',
      icon: 'fingerprint',
    });
    expect(writes).toEqual([]);
  });

  test('a machine with no Git author still has a system identity to choose', async () => {
    globalIdentityResponse = { userName: null, userEmail: null };
    expect(await useGitIdentitiesStore.getState().loadGlobalIdentity()).toBe(true);

    // Without it there is nothing to select, and a clone cannot even start.
    expect(useGitIdentitiesStore.getState().globalIdentity).toEqual({
      id: 'global', name: '', userName: '', userEmail: '', color: 'info', icon: 'fingerprint',
    });
    expect(writes).toEqual([]);
  });

  test('a stale profile load cannot publish into the replacement runtime', async () => {
    let resolveRead: (response: Response) => void = () => undefined;
    pendingProfileRead = new Promise((resolve) => { resolveRead = resolve; });
    const loading = useGitIdentitiesStore.getState().loadProfiles();

    useGitIdentitiesStore.getState().resetForRuntimeSwitch('runtime-b');
    const runtimeBProfile = { ...author, name: 'Runtime B' };
    useGitIdentitiesStore.setState({ profiles: [runtimeBProfile], selectedProfileId: author.id });
    resolveRead(Response.json([{ ...author, name: 'Runtime A' }]));

    expect(await loading).toBe(false);
    expect(useGitIdentitiesStore.getState().profiles).toEqual([runtimeBProfile]);
    expect(useGitIdentitiesStore.getState().selectedProfileId).toBe(author.id);
  });

  test('a stale same-ID update cannot replace the new runtime profile', async () => {
    useGitIdentitiesStore.setState({ profiles: [author] });
    let resolveWrite: (response: Response) => void = () => undefined;
    pendingProfileWrite = new Promise((resolve) => { resolveWrite = resolve; });
    const updating = useGitIdentitiesStore.getState().updateProfile(author.id, { name: 'Runtime A edit' });

    useGitIdentitiesStore.getState().resetForRuntimeSwitch('runtime-b');
    const runtimeBProfile = { ...author, name: 'Runtime B' };
    useGitIdentitiesStore.setState({ profiles: [runtimeBProfile] });
    resolveWrite(Response.json({ ...author, name: 'Runtime A edit' }));

    expect(await updating).toBe(false);
    expect(useGitIdentitiesStore.getState().profiles).toEqual([runtimeBProfile]);
  });
});
