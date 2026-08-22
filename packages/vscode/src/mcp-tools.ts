import { spawn } from 'child_process';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TOOLS = 500;
const CLIENT_INFO = { name: 'openchamber', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';
// Newline framing is the modern default (current MCP SDK), so it gets the larger
// share of the overall local-probe timeout; Content-Length is a fallback for
// older servers. Both floors keep a real, if short, chance for the fallback
// attempt even when the caller configures a very small overall timeout.
const NEWLINE_ATTEMPT_SHARE = 0.65;
const NEWLINE_ATTEMPT_MIN_MS = 3_000;
const CONTENT_LENGTH_ATTEMPT_MIN_MS = 2_000;

export type McpToolsProbeConfig = {
  name?: string;
  type?: 'local' | 'remote';
  command?: string[];
  url?: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  timeout?: number;
  oauth?: false | Record<string, unknown>;
  enabled?: boolean;
};

export type McpToolInfo = {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: unknown;
};

export type McpToolsListResult = {
  tools: McpToolInfo[];
  serverInfo?: { name?: string; title?: string; version?: string };
  truncated?: boolean;
};

const asTrimmedString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const resolveTimeoutMs = (config?: McpToolsProbeConfig): number => {
  if (typeof config?.timeout === 'number' && Number.isFinite(config.timeout) && config.timeout > 0) {
    return Math.min(Math.max(Math.floor(config.timeout), 1_000), 120_000);
  }
  return DEFAULT_TIMEOUT_MS;
};

const encodeContentLength = (message: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'), body]);
};

const encodeNewline = (message: unknown): Buffer => Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');

const normalizeTool = (raw: any): McpToolInfo | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = asTrimmedString(raw.name);
  if (!name) return null;
  const tool: McpToolInfo = { name };
  if (typeof raw.description === 'string' && raw.description.trim()) tool.description = raw.description.trim();
  if (typeof raw.title === 'string' && raw.title.trim()) tool.title = raw.title.trim();
  if (raw.inputSchema !== undefined) tool.inputSchema = raw.inputSchema;
  return tool;
};

const normalizeTools = (rawTools: unknown): { tools: McpToolInfo[]; truncated: boolean } => {
  if (!Array.isArray(rawTools)) return { tools: [], truncated: false };
  const tools: McpToolInfo[] = [];
  for (const entry of rawTools) {
    if (tools.length >= MAX_TOOLS) {
      return { tools, truncated: true };
    }
    const tool = normalizeTool(entry);
    if (tool) tools.push(tool);
  }
  return { tools, truncated: false };
};

type Deadline = { remaining: () => number; expired: () => boolean };

const createDeadline = (timeoutMs: number): Deadline => {
  const deadline = Date.now() + timeoutMs;
  return {
    remaining: () => Math.max(0, deadline - Date.now()),
    expired: () => Date.now() >= deadline,
  };
};

async function listLocalMcpToolsWithFraming(
  command: string[],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  // Shared across both framing attempts so a stalling server cannot double the
  // worst-case wait for the caller.
  deadline: Deadline,
  framing: 'content-length' | 'newline',
): Promise<McpToolsListResult> {
  if (deadline.expired()) {
    throw new Error('Timed out listing local MCP tools');
  }

  const [cmd, ...args] = command;
  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdoutBuffer = Buffer.alloc(0);
  const pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  let nextId = 1;
  let contentLength: number | null = null;
  let settled = false;
  let stderrTail = '';

  const failPending = (error: Error) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const handleMessage = (message: any) => {
    if (!message || typeof message !== 'object' || message.id == null) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(typeof message.error?.message === 'string' ? message.error.message : 'MCP request failed'));
      return;
    }
    entry.resolve(message.result);
  };

  const consumeStdout = () => {
    while (true) {
      if (contentLength == null) {
        const headerEnd = stdoutBuffer.indexOf('\r\n\r\n');
        if (headerEnd >= 0) {
          const header = stdoutBuffer.subarray(0, headerEnd).toString('utf8');
          const match = /Content-Length:\s*(\d+)/i.exec(header);
          if (!match) {
            stdoutBuffer = stdoutBuffer.subarray(headerEnd + 4);
            continue;
          }
          contentLength = Number(match[1]);
          stdoutBuffer = stdoutBuffer.subarray(headerEnd + 4);
          continue;
        }

        const newlineIndex = stdoutBuffer.indexOf(0x0a);
        if (newlineIndex < 0) return;
        const line = stdoutBuffer.subarray(0, newlineIndex).toString('utf8').trim();
        stdoutBuffer = stdoutBuffer.subarray(newlineIndex + 1);
        if (!line || line.toLowerCase().startsWith('content-length:')) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch {
          // ignore
        }
        continue;
      }

      if (stdoutBuffer.length < contentLength) return;
      const body = stdoutBuffer.subarray(0, contentLength).toString('utf8');
      stdoutBuffer = stdoutBuffer.subarray(contentLength);
      contentLength = null;
      try {
        handleMessage(JSON.parse(body));
      } catch {
        // ignore
      }
    }
  };

  child.stdout?.on('data', (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    consumeStdout();
  });
  // Without an error listener, a stream failure (e.g. the process exiting mid-read)
  // throws unhandled and can crash the whole extension host.
  child.stdout?.on('error', () => {
    // Surfaced via 'exit'/'error' on the child itself; nothing actionable here.
  });
  child.stdin?.on('error', () => {
    // Writing after the child has exited raises EPIPE; pending request timers and
    // the 'exit'/'error' handlers below already fail the in-flight requests.
  });
  child.stderr?.on('data', (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    stderrTail = `${stderrTail}${text}`.slice(-2_000);
  });
  child.stderr?.on('error', () => {
    // Best-effort diagnostics only.
  });

  let killTimer: NodeJS.Timeout | null = null;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    failPending(new Error('MCP process closed'));
    try {
      if (!child.killed) child.kill('SIGTERM');
    } catch {
      // ignore
    }
    killTimer = setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 1_000);
    killTimer.unref?.();
  };

  child.on('error', (error) => {
    failPending(error instanceof Error ? error : new Error(String(error)));
    cleanup();
  });
  child.on('exit', () => {
    // The process has already exited; the pending SIGKILL escalation is moot.
    if (killTimer) clearTimeout(killTimer);
    cleanup();
  });

  const encode = framing === 'newline' ? encodeNewline : encodeContentLength;
  const request = (method: string, params?: unknown) => {
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    const budgetMs = deadline.remaining();
    if (budgetMs <= 0) {
      return Promise.reject(new Error(`Timed out waiting for MCP ${method}`));
    }
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for MCP ${method}`));
      }, budgetMs);
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin?.write(encode(message));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const notify = (method: string) => {
    try {
      child.stdin?.write(encode({ jsonrpc: '2.0', method }));
    } catch {
      // Best-effort notification; a write failure here surfaces via the next request.
    }
  };

  try {
    const initResult = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    notify('notifications/initialized');
    const toolsResult = await request('tools/list', {});
    const { tools, truncated } = normalizeTools(toolsResult?.tools);
    return {
      tools,
      truncated,
      serverInfo: initResult?.serverInfo && typeof initResult.serverInfo === 'object'
        ? {
            name: asTrimmedString(initResult.serverInfo.name) || undefined,
            title: asTrimmedString(initResult.serverInfo.title) || undefined,
            version: asTrimmedString(initResult.serverInfo.version) || undefined,
          }
        : undefined,
    };
  } catch (error) {
    throw new Error(stderrTail.trim() || (error instanceof Error ? error.message : String(error)));
  } finally {
    cleanup();
  }
}

export async function listLocalMcpTools(
  config: McpToolsProbeConfig,
  options: { cwd?: string | null; timeoutMs?: number } = {},
): Promise<McpToolsListResult> {
  const command = Array.isArray(config.command)
    ? config.command.map(String).filter((part) => part.length > 0)
    : [];
  if (command.length === 0) {
    throw new Error('Local MCP server command is required');
  }

  const timeoutMs = options.timeoutMs ?? resolveTimeoutMs(config);
  const cwd = asTrimmedString(options.cwd) || undefined;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.environment && typeof config.environment === 'object' && !Array.isArray(config.environment)
      ? Object.fromEntries(
          Object.entries(config.environment)
            .filter(([key, value]) => key && value !== undefined && value !== null)
            .map(([key, value]) => [String(key), String(value)]),
        )
      : {}),
  };

  // Current MCP SDK stdio transport uses newline-delimited JSON; some older
  // servers still speak Content-Length frames. Fresh process per attempt.
  // The overall configured timeout is split between the two attempts (instead
  // of each attempt getting its own full timeout) so a server that never
  // responds cannot hold the request for roughly 2x the configured timeout.
  const newlineBudgetMs = Math.max(NEWLINE_ATTEMPT_MIN_MS, Math.round(timeoutMs * NEWLINE_ATTEMPT_SHARE));
  const contentLengthBudgetMs = Math.max(CONTENT_LENGTH_ATTEMPT_MIN_MS, timeoutMs - newlineBudgetMs);

  try {
    return await listLocalMcpToolsWithFraming(command, env, cwd, createDeadline(newlineBudgetMs), 'newline');
  } catch (newlineError) {
    try {
      return await listLocalMcpToolsWithFraming(command, env, cwd, createDeadline(contentLengthBudgetMs), 'content-length');
    } catch (contentLengthError) {
      const detail = (newlineError instanceof Error ? newlineError.message : String(newlineError))
        || (contentLengthError instanceof Error ? contentLengthError.message : String(contentLengthError));
      throw new Error(`Failed to list tools from local MCP server: ${detail}`);
    }
  }
}

const parseSseJsonPayloads = (text: string): any[] => {
  const payloads: any[] = [];
  for (const block of String(text || '').split(/\n\n+/)) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') continue;
    try {
      payloads.push(JSON.parse(data));
    } catch {
      // ignore
    }
  }
  return payloads;
};

async function postJsonRpc(url: string, headers: Record<string, string>, message: any, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Remote MCP HTTP ${response.status}: ${text.slice(0, 300) || response.statusText}`);
    }
    if (contentType.includes('text/event-stream')) {
      const payloads = parseSseJsonPayloads(text);
      const match = payloads.find((payload) => payload && payload.id === message.id);
      if (!match) throw new Error('Remote MCP SSE response did not include the requested result');
      return match;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Remote MCP returned a non-JSON response');
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function listRemoteMcpTools(
  config: McpToolsProbeConfig,
  options: { timeoutMs?: number } = {},
): Promise<McpToolsListResult> {
  const url = asTrimmedString(config.url);
  if (!url) throw new Error('Remote MCP server URL is required');
  if (config.oauth && typeof config.oauth === 'object') {
    throw new Error('Listing tools for OAuth-protected remote MCP servers is not supported from Settings yet. Authorize and connect the server in OpenCode, or disable OAuth if the server allows anonymous access.');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Remote MCP server URL is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Remote MCP server URL must be http or https');
  }

  const timeoutMs = options.timeoutMs ?? resolveTimeoutMs(config);
  const headers: Record<string, string> = {};
  if (config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)) {
    for (const [key, value] of Object.entries(config.headers)) {
      if (!key || value === undefined || value === null) continue;
      headers[String(key)] = String(value);
    }
  }

  const deadline = createDeadline(timeoutMs);
  const initResponse = await postJsonRpc(url, headers, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
  }, deadline.remaining() || 1_000);

  if (initResponse?.error) {
    throw new Error(typeof initResponse.error?.message === 'string' ? initResponse.error.message : 'Remote MCP initialize failed');
  }

  try {
    await postJsonRpc(url, headers, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, Math.min(3_000, deadline.remaining() || 1_000));
  } catch {
    // ignore
  }

  if (deadline.expired()) throw new Error('Timed out listing remote MCP tools');

  const toolsResponse = await postJsonRpc(url, headers, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  }, deadline.remaining() || 1_000);

  if (toolsResponse?.error) {
    throw new Error(typeof toolsResponse.error?.message === 'string' ? toolsResponse.error.message : 'Remote MCP tools/list failed');
  }

  const { tools, truncated } = normalizeTools(toolsResponse?.result?.tools ?? toolsResponse?.tools);
  return {
    tools,
    truncated,
    serverInfo: initResponse?.result?.serverInfo && typeof initResponse.result.serverInfo === 'object'
      ? {
          name: asTrimmedString(initResponse.result.serverInfo.name) || undefined,
          title: asTrimmedString(initResponse.result.serverInfo.title) || undefined,
          version: asTrimmedString(initResponse.result.serverInfo.version) || undefined,
        }
      : undefined,
  };
}

export async function listMcpTools(
  config: McpToolsProbeConfig,
  options: { cwd?: string | null; timeoutMs?: number } = {},
): Promise<McpToolsListResult> {
  if (!config || typeof config !== 'object') {
    throw new Error('MCP configuration is required');
  }
  if (config.enabled === false) {
    throw new Error('MCP server is disabled');
  }
  if (config.type === 'remote') {
    return listRemoteMcpTools(config, options);
  }
  return listLocalMcpTools(config, options);
}
