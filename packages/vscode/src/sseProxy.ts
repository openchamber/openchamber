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

// SSE reconnect configuration
const MAX_RECONNECTS = 3;
const BASE_RECONNECT_DELAY = 1000; // 1 second

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) {
    resolve();
    return;
  }

  const timeout = setTimeout(() => {
    signal.removeEventListener('abort', handleAbort);
    resolve();
  }, ms);
  const handleAbort = () => {
    clearTimeout(timeout);
    resolve();
  };
  signal.addEventListener('abort', handleAbort, { once: true });
});

const getAbortReason = (signal: AbortSignal) => signal.reason ?? new DOMException('Aborted', 'AbortError');

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

  // Reconnect logic with exponential backoff
  let reconnectAttempts = 0;

  const connect = async (): Promise<{ stream: AsyncIterable<unknown> }> => {
    try {
      console.log(`[SSE] Connecting to ${pathname} (attempt ${reconnectAttempts + 1}/${MAX_RECONNECTS + 1})`);

      if (pathname === '/global/event') {
        try {
          const result = await client.global.event(getSseOptions(signal, onChunk));
          // Reset reconnect counter on successful connection
          reconnectAttempts = 0;
          return result;
        } catch (error) {
          if ((error as Error)?.name === 'AbortError' || signal.aborted) {
            throw error;
          }
          // Fallback to directory event on error
          console.warn('[SSE] Global event failed, falling back to directory event', error);
          const result = client.event.subscribe(
            { directory: resolvedDirectory },
            getSseOptions(signal, onChunk, resolvedDirectory),
          );
          reconnectAttempts = 0;
          return result;
        }
      }

      const result = client.event.subscribe(
        { directory: resolvedDirectory },
        getSseOptions(signal, onChunk),
      );
      reconnectAttempts = 0;
      return result;
    } catch (error) {
      // Implement reconnect logic
      if (!signal.aborted && reconnectAttempts < MAX_RECONNECTS) {
        reconnectAttempts++;
        const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1); // Exponential backoff

        console.warn(
          `[SSE] Connection failed (attempt ${reconnectAttempts}/${MAX_RECONNECTS}), ` +
          `retrying in ${delay}ms...`,
          error
        );

        await sleep(delay, signal);
        if (signal.aborted) {
          throw getAbortReason(signal);
        }
        return connect(); // Recursive retry
      }

      console.error(`[SSE] Connection failed after ${reconnectAttempts} attempts`, error);
      throw error;
    }
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

      // Attempt reconnect on socket errors
      if (!signal.aborted) {
        if (cause?.code === 'UND_ERR_SOCKET' || cause?.code === 'ECONNRESET') {
          console.warn('[SSE] Socket error detected, attempting reconnect...');

          if (reconnectAttempts < MAX_RECONNECTS) {
            reconnectAttempts++;
            const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
            await sleep(delay, signal);
            if (signal.aborted) {
              return;
            }

            // Attempt to reconnect
            try {
              const newResult = await connect();
              for await (const _ of newResult.stream) {
                void _;
                if (signal.aborted) break;
              }
              return; // Successfully reconnected
            } catch (reconnectError) {
              console.error('[SSE] Reconnect failed', reconnectError);
            }
          }
        }

        // Re-throw if we couldn't recover
        throw error;
      }
    }
  })();

  return {
    headers: { ...SSE_RESPONSE_HEADERS },
    run,
  };
};
