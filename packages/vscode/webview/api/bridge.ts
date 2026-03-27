declare const acquireVsCodeApi: () => {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

interface VSCodeAPI {
  postMessage: (message: unknown) => void;
}

let vscodeApi: VSCodeAPI | null = null;

function getVSCodeAPI(): VSCodeAPI {
  if (!vscodeApi) {
    vscodeApi = acquireVsCodeApi();
  }
  return vscodeApi;
}

// Export vscode API for direct use
export const vscode = {
  postMessage: (message: unknown) => getVSCodeAPI().postMessage(message),
};

interface BridgeRequest {
  id: string;
  type: string;
  payload?: unknown;
}

interface BridgeResponse {
  id: string;
  type: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}>();

let requestIdCounter = 0;

window.addEventListener('message', (event: MessageEvent<BridgeResponse>) => {
  const response = event.data;
  if (!response || typeof response.id !== 'string') return;

  const pending = pendingRequests.get(response.id);
  if (pending) {
    pendingRequests.delete(response.id);
    if (response.success) {
      pending.resolve(response.data);
    } else {
      pending.reject(new Error(response.error || 'Unknown error'));
    }
  }
});

export function sendBridgeMessage<T = unknown>(type: string, payload?: unknown): Promise<T> {
  return sendBridgeMessageWithOptions<T>(type, payload);
}

export function sendBridgeMessageWithOptions<T = unknown>(
  type: string,
  payload?: unknown,
  options?: { timeoutMs?: number }
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `req_${++requestIdCounter}_${Date.now()}`;
    const request: BridgeRequest = { id, type, payload };

    pendingRequests.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });

    const timeoutMs = typeof options?.timeoutMs === 'number' ? options.timeoutMs : 30000;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`Request ${type} timed out`));
        }
      }, timeoutMs);
    }

    getVSCodeAPI().postMessage(request);
  });
}

export type ProxiedApiResponse = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};

export async function proxyApiRequest(options: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
}): Promise<ProxiedApiResponse> {
  // Do not impose a bridge-level timeout. Let the original fetch's AbortSignal
  // (or OpenCode server response timing) control the lifecycle.
  return sendBridgeMessageWithOptions<ProxiedApiResponse>('api:proxy', options, { timeoutMs: 0 });
}

export async function proxySessionMessageRequest(options: {
  path: string;
  headers?: Record<string, string>;
  bodyText: string;
}): Promise<ProxiedApiResponse> {
  // Keep parity with server-side direct forwarder: let extension host control timeout.
  return sendBridgeMessageWithOptions<ProxiedApiResponse>('api:session:message', options, { timeoutMs: 0 });
}

export type ProxiedSseStartResponse = {
  status: number;
  headers: Record<string, string>;
  streamId: string | null;
  error?: string;
};

export async function startSseProxy(options: {
  path: string;
  headers?: Record<string, string>;
}): Promise<ProxiedSseStartResponse> {
  return sendBridgeMessage<ProxiedSseStartResponse>('api:sse:start', options);
}

export async function stopSseProxy(options: { streamId: string }): Promise<{ stopped: boolean }> {
  return sendBridgeMessage<{ stopped: boolean }>('api:sse:stop', options);
}

export async function executeVSCodeCommand(command: string, args?: unknown[]): Promise<{ result?: unknown }> {
  return sendBridgeMessage<{ result?: unknown }>('vscode:command', { command, args });
}

export async function openVSCodeExternalUrl(url: string): Promise<void> {
  await sendBridgeMessage('vscode:openExternalUrl', { url });
}

type CommandHandler = (payload: unknown) => void;
const commandHandlers = new Map<string, CommandHandler>();

export function onCommand(command: string, handler: CommandHandler): () => void {
  commandHandlers.set(command, handler);
  return () => commandHandlers.delete(command);
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;
  if (message?.type === 'command' && message.command) {
    const handler = commandHandlers.get(message.command);
    if (handler) {
      handler(message.payload);
    }
  }
});

type ThemeChangePayload =
  | 'light'
  | 'dark'
  | {
      kind?: 'light' | 'dark' | 'high-contrast';
      shikiThemes?: { light?: Record<string, unknown>; dark?: Record<string, unknown> } | null;
    };
type ThemeChangeHandler = (theme: ThemeChangePayload) => void;
let themeChangeHandler: ThemeChangeHandler | null = null;

export function onThemeChange(handler: ThemeChangeHandler): () => void {
  themeChangeHandler = handler;
  return () => { themeChangeHandler = null; };
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;
  if (message?.type === 'themeChange' && themeChangeHandler) {
    themeChangeHandler(message.theme);
  }
});
