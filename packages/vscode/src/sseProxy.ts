import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { OpenCodeManager } from './opencode';
import { waitForApiUrl } from './opencode-ready';

type StreamEvent<TData = unknown> = {
  data: TData;
  event?: string;
  id?: string;
  retry?: number;
};

type OpenSseProxyOptions = {
  manager: OpenCodeManager;
  path: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  onChunk: (chunk: string) => void;
};

type OpenSseProxyResult = {
  headers: Record<string, string>;
  run: Promise<void>;
};

const SSE_RESPONSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
} as const;

const serializeSseEventBlock = (event: StreamEvent<unknown>): string => {
  const lines: string[] = [];
  if (typeof event.id === 'string' && event.id.length > 0) {
    lines.push(`id: ${event.id}`);
  }
  if (typeof event.event === 'string' && event.event.length > 0) {
    lines.push(`event: ${event.event}`);
  }
  if (typeof event.retry === 'number' && Number.isFinite(event.retry)) {
    lines.push(`retry: ${event.retry}`);
  }
  lines.push(`data: ${JSON.stringify(event.data)}`);
  return lines.join('\n');
};

const normalizeSsePath = (path: string): { pathname: '/event' | '/global/event'; directory: string | null } => {
  const parsed = new URL(path, 'https://openchamber.invalid');
  const pathname = parsed.pathname === '/global/event' ? '/global/event' : '/event';
  const directory = parsed.searchParams.get('directory');
  return {
    pathname,
    directory: typeof directory === 'string' && directory.trim().length > 0 ? directory.trim() : null,
  };
};

const resolveDefaultDirectory = (manager: OpenCodeManager): string => {
  return manager.getWorkingDirectory() || 'global';
};

const createAuthedClient = async (manager: OpenCodeManager, headers?: Record<string, string>) => {
  const baseUrl = await waitForApiUrl(manager);
  if (!baseUrl) {
    throw new Error('OpenCode API URL not available');
  }

  return createOpencodeClient({
    baseUrl,
    headers: {
      ...(headers || {}),
      ...manager.getOpenCodeAuthHeaders(),
    },
  });
};

const getSseOptions = (
  signal: AbortSignal,
  onChunk: (chunk: string) => void,
  wrapDirectory?: string,
) => ({
  signal,
  sseMaxRetryAttempts: 0,
  onSseEvent: (event: StreamEvent<unknown>) => {
    const nextEvent = wrapDirectory
      ? {
          ...event,
          data: {
            directory: wrapDirectory,
            payload: event.data,
          },
        }
      : event;
    onChunk(`${serializeSseEventBlock(nextEvent)}\n\n`);
  },
});

export const openSseProxy = async ({
  manager,
  path,
  headers,
  signal,
  onChunk,
}: OpenSseProxyOptions): Promise<OpenSseProxyResult> => {
  const client = await createAuthedClient(manager, headers);
  const { pathname, directory } = normalizeSsePath(path);
  const resolvedDirectory = directory || resolveDefaultDirectory(manager);

  const connect = async () => {
    if (pathname === '/global/event') {
      try {
        return await client.global.event(getSseOptions(signal, onChunk));
      } catch (error) {
        if ((error as Error)?.name === 'AbortError' || signal.aborted) {
          throw error;
        }
        return client.event.subscribe(
          { directory: resolvedDirectory },
          getSseOptions(signal, onChunk, resolvedDirectory),
        );
      }
    }

    return client.event.subscribe(
      { directory: resolvedDirectory },
      getSseOptions(signal, onChunk),
    );
  };

  const result = await connect();
  const run = (async () => {
    try {
      for await (const _ of result.stream) {
        void _;
        if (signal.aborted) {
          break;
        }
      }
    } catch (error: unknown) {
      const cause = (error as { cause?: { code?: string } } | null)?.cause;
      if (!signal.aborted && cause?.code !== 'UND_ERR_SOCKET') {
        throw error;
      }
    }
  })();

  return {
    headers: { ...SSE_RESPONSE_HEADERS },
    run,
  };
};
