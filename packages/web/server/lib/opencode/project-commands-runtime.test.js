import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({
  createOpencodeClient: vi.fn(),
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: sdkMocks.createOpencodeClient,
}));

const { createOpenCodeProjectCommandRuntime } = await import('./project-commands-runtime.js');

describe('createOpenCodeProjectCommandRuntime', () => {
  beforeEach(() => {
    sdkMocks.createOpencodeClient.mockReset();
  });

  const createRuntime = (overrides = {}) => createOpenCodeProjectCommandRuntime({
    buildOpenCodeUrl: (requestPath, prefix) => `http://127.0.0.1:4096${prefix ?? ''}${requestPath}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
    getOpenCodePort: () => 4096,
    ...overrides,
  });

  it('loads commands.start from the authoritative current project API by ID', async () => {
    const project = {
      current: vi.fn().mockResolvedValue({ data: { id: 'project-a', commands: { start: ' bun dev ' } } }),
      list: vi.fn(),
    };
    sdkMocks.createOpencodeClient.mockReturnValue({ project });

    await expect(createRuntime().loadStartCommand('project-a', '/repo')).resolves.toEqual({
      available: true,
      command: 'bun dev',
    });
    expect(project.current).toHaveBeenCalledWith({ directory: '/repo' });
    expect(project.list).not.toHaveBeenCalled();
  });

  it('returns authoritative empty commands without marking the API unavailable', async () => {
    sdkMocks.createOpencodeClient.mockReturnValue({
      project: {
        current: vi.fn().mockResolvedValue({ data: { worktree: '/repo', commands: { start: '   ' } } }),
        list: vi.fn(),
      },
    });

    await expect(createRuntime().loadStartCommand('project-a', '/repo')).resolves.toEqual({
      available: true,
      command: '',
    });
  });

  it('falls back from a current project without usable identity or directory to project.list', async () => {
    const project = {
      current: vi.fn().mockResolvedValue({ data: { commands: { start: 'wrong' } } }),
      list: vi.fn().mockResolvedValue({
        data: [
          { id: 'other', worktree: '/other', commands: { start: 'wrong' } },
          { id: 'project-a', commands: { start: 'bun start' } },
        ],
      }),
    };
    sdkMocks.createOpencodeClient.mockReturnValue({ project });

    await expect(createRuntime().loadStartCommand('project-a', '/repo')).resolves.toEqual({
      available: true,
      command: 'bun start',
    });
    expect(project.list).toHaveBeenCalledWith({ directory: '/repo' });
  });

  it('prefers exact ID over exact worktree in project.list', async () => {
    sdkMocks.createOpencodeClient.mockReturnValue({
      project: {
        current: vi.fn().mockResolvedValue({ data: { id: 'other', worktree: '/other' } }),
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'other', worktree: '/repo', commands: { start: 'by worktree' } },
            { id: 'project-a', worktree: '/other', commands: { start: 'by id' } },
          ],
        }),
      },
    });

    await expect(createRuntime().loadStartCommand('project-a', '/repo')).resolves.toEqual({
      available: true,
      command: 'by id',
    });
  });

  it('reports unavailable for disabled, throwing, or unmatched API lookups', async () => {
    await expect(createRuntime({ getOpenCodePort: () => null }).loadStartCommand('project-a', '/repo')).resolves.toEqual({
      available: false,
      command: '',
    });
    expect(sdkMocks.createOpencodeClient).not.toHaveBeenCalled();

    sdkMocks.createOpencodeClient.mockReturnValueOnce({
      project: {
        current: vi.fn().mockRejectedValue(new Error('network down')),
        list: vi.fn(),
      },
    });
    await expect(createRuntime().loadStartCommand('project-a', '/repo')).resolves.toEqual({
      available: false,
      command: '',
    });

    sdkMocks.createOpencodeClient.mockReturnValueOnce({
      project: {
        current: vi.fn().mockResolvedValue({ data: { id: 'other', worktree: '/other' } }),
        list: vi.fn().mockResolvedValue({ data: [{ id: 'elsewhere' }] }),
      },
    });
    await expect(createRuntime().loadStartCommand('project-a', '/repo')).resolves.toEqual({
      available: false,
      command: '',
    });
  });

  it('creates a fresh SDK client with current URL, auth headers, directory, and timeout fetch', async () => {
    const headers = { Authorization: 'Bearer secret-test-token' };
    const buildOpenCodeUrl = vi.fn(() => 'http://127.0.0.1:4096/');
    const getOpenCodeAuthHeaders = vi.fn(() => headers);
    sdkMocks.createOpencodeClient.mockReturnValue({
      project: {
        current: vi.fn().mockResolvedValue({ data: { id: 'project-a', commands: { start: 'bun dev' } } }),
        list: vi.fn(),
      },
    });

    await createRuntime({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).loadStartCommand('project-a', '/repo');

    expect(buildOpenCodeUrl).toHaveBeenCalledWith('/', '');
    expect(getOpenCodeAuthHeaders).toHaveBeenCalledTimes(1);
    expect(sdkMocks.createOpencodeClient).toHaveBeenCalledTimes(1);
    const options = sdkMocks.createOpencodeClient.mock.calls[0][0];
    expect(options).toMatchObject({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/repo',
      headers,
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    try {
      const controller = new AbortController();
      const request = new Request('http://127.0.0.1:4096/project', { signal: controller.signal });
      await options.fetch(request);
      const fetchSignal = fetchSpy.mock.calls[0][1].signal;
      expect(fetchSpy).toHaveBeenCalledWith(request, { signal: fetchSignal });
      expect(fetchSignal).toBeInstanceOf(AbortSignal);
      expect(fetchSignal).not.toBe(controller.signal);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
