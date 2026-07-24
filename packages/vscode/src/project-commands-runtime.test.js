import { beforeEach, describe, expect, it, mock } from 'bun:test';

const createOpencodeClient = mock();

const { createOpenCodeProjectCommandRuntime } = await import('./project-commands-runtime');

describe('VS Code project commands runtime', () => {
  beforeEach(() => {
    createOpencodeClient.mockReset();
  });

  const createRuntime = (overrides = {}) => createOpenCodeProjectCommandRuntime({
    getApiUrl: () => 'http://127.0.0.1:4096/',
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
    createClient: createOpencodeClient,
    ...overrides,
  });

  it('loads commands.start from the authoritative current project API by ID', async () => {
    const project = {
      current: mock(async () => ({ data: { id: 'project-a', commands: { start: ' bun dev ' } } })),
      list: mock(),
    };
    createOpencodeClient.mockReturnValue({ project });

    expect(await createRuntime().loadStartCommand('project-a', '/repo')).toEqual({
      available: true,
      command: 'bun dev',
    });
    expect(project.current).toHaveBeenCalledWith({ directory: '/repo' });
    expect(project.list).not.toHaveBeenCalled();
  });

  it('preserves authoritative empty commands', async () => {
    createOpencodeClient.mockReturnValue({
      project: {
        current: mock(async () => ({ data: { id: 'project-a', commands: { start: '   ' } } })),
        list: mock(),
      },
    });

    expect(await createRuntime().loadStartCommand('project-a', '/repo')).toEqual({
      available: true,
      command: '',
    });
  });

  it('falls back to list and prefers exact ID before worktree', async () => {
    const project = {
      current: mock(async () => ({ data: { commands: { start: 'wrong' } } })),
      list: mock(async () => ({
        data: [
          { id: 'other', worktree: '/repo', commands: { start: 'by worktree' } },
          { id: 'project-a', worktree: '/other', commands: { start: 'by id' } },
        ],
      })),
    };
    createOpencodeClient.mockReturnValue({ project });

    expect(await createRuntime().loadStartCommand('project-a', '/repo')).toEqual({
      available: true,
      command: 'by id',
    });
    expect(project.list).toHaveBeenCalledWith({ directory: '/repo' });
  });

  it('reports unavailable for missing URL, API errors, or unmatched projects', async () => {
    expect(await createRuntime({ getApiUrl: () => null }).loadStartCommand('project-a', '/repo')).toEqual({
      available: false,
      command: '',
    });
    expect(createOpencodeClient).not.toHaveBeenCalled();

    createOpencodeClient.mockReturnValueOnce({
      project: { current: mock(async () => { throw new Error('offline'); }), list: mock() },
    });
    expect(await createRuntime().loadStartCommand('project-a', '/repo')).toEqual({
      available: false,
      command: '',
    });

    createOpencodeClient.mockReturnValueOnce({
      project: {
        current: mock(async () => ({ data: { id: 'other', worktree: '/other' } })),
        list: mock(async () => ({ data: [{ id: 'elsewhere' }] })),
      },
    });
    expect(await createRuntime().loadStartCommand('project-a', '/repo')).toEqual({
      available: false,
      command: '',
    });
  });

  it('creates a fresh SDK client with current URL, auth headers, directory, and timeout fetch', async () => {
    const headers = { Authorization: 'Bearer secret-test-token' };
    const getApiUrl = mock(() => 'http://127.0.0.1:4096/');
    const getOpenCodeAuthHeaders = mock(() => headers);
    createOpencodeClient.mockReturnValue({
      project: {
        current: mock(async () => ({ data: { id: 'project-a', commands: { start: 'bun dev' } } })),
        list: mock(),
      },
    });

    await createRuntime({ getApiUrl, getOpenCodeAuthHeaders }).loadStartCommand('project-a', '/repo');

    expect(getApiUrl).toHaveBeenCalledTimes(1);
    expect(getOpenCodeAuthHeaders).toHaveBeenCalledTimes(1);
    expect(createOpencodeClient).toHaveBeenCalledTimes(1);
    const options = createOpencodeClient.mock.calls[0][0];
    expect(options).toMatchObject({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/repo',
      headers,
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => new Response('{}'));
    globalThis.fetch = fetchMock;
    try {
      const controller = new AbortController();
      const request = new Request('http://127.0.0.1:4096/project', { signal: controller.signal });
      await options.fetch(request);
      const fetchSignal = fetchMock.mock.calls[0][1]?.signal;
      expect(fetchMock).toHaveBeenCalledWith(request, { signal: fetchSignal });
      expect(fetchSignal).toBeInstanceOf(AbortSignal);
      expect(fetchSignal).not.toBe(controller.signal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
