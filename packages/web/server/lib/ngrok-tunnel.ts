import { spawn, spawnSync } from 'child_process';
import type { TunnelAvailability, TunnelReachabilityOptions } from './tunnel-process-contracts.js';
import { interruptTunnelProcess } from './tunnel-process-contracts.js';
import {
  createExecutableSearchEnv,
  resolveExecutableLaunchTarget,
} from './tunnels/executable-search.js';
import { getTunnelDependencyInstallInfo } from './tunnels/install-help.js';
import { TUNNEL_PROVIDER_NGROK } from './tunnels/types.js';
import { readBoundedResponseJson } from './shared/response-body.js';
import { createBoundedOutputAccumulator } from './shared/bounded-output-accumulator.js';
import { isFunction } from './shared/object-guards.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
// spawnSync blocks the whole server event loop while it waits, so a hung
// ngrok binary must be bounded: probe timeouts elsewhere in the tree use
// 5-10 s (package-manager) and this matches the 5 s reachability deadline
// used by checkNgrokApiReachability below.
const AVAILABILITY_CHECK_TIMEOUT_MS = 5000;
const NGROK_API_URL = 'http://127.0.0.1:4040/api/tunnels';
// The agent API is on localhost and answers in milliseconds when healthy,
// so its readiness-poll deadline is far shorter than the 5 s internet
// reachability check above and far under the 30 s startup timeout.
const NGROK_POLL_TIMEOUT_MS = 2000;
const NGROK_POLL_INTERVAL_MS = 250;
// A tunnels listing is a handful of small entries (name, proto,
// public_url, config), so the 64 KiB cap that bounds version answers
// in opencode/compatibility.js is generous headroom for a healthy
// answer while still refusing to buffer an unbounded body from a
// fast loopback source on every poll.
const NGROK_TUNNELS_RESPONSE_MAX_BYTES = 64 * 1024;
const NGROK_PUBLIC_URL_REGEX = /https:\/\/[^\s"']+/i;
// ngrok writes its tunnel URL and log lines with no regard for pipe chunk
// boundaries, so output is matched over the shared bounded accumulator
// (lib/shared/bounded-output-accumulator.js, #1705) over complete lines,
// never per chunk: a URL fragment at the end of a chunk would otherwise
// be accepted as the tunnel URL and settle startup with a truncated
// address.
const NGROK_AUTHTOKEN_HELP = 'Run: ngrok config add-authtoken <your-ngrok-token>';
const getNgrokInstallInfo = () => getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_NGROK);

interface NgrokLog {
  url?: unknown;
  public_url?: unknown;
  lvl?: unknown;
  err?: unknown;
  msg?: unknown;
}

interface NgrokTunnel {
  proto?: unknown;
  public_url?: unknown;
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isFetch = (value: unknown): value is typeof fetch => typeof value === 'function';
const isNgrokLog = (value: unknown): value is NgrokLog =>
  value !== null && typeof value === 'object';
const isNgrokTunnel = (value: unknown): value is NgrokTunnel =>
  value !== null && typeof value === 'object';
const hasTunnels = (value: unknown): value is { tunnels?: unknown } =>
  value !== null && typeof value === 'object';

const readNgrokLog = (text: string) => {
  try {
    const parsed: unknown = JSON.parse(text);
    return isNgrokLog(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export async function checkNgrokAvailable({ timeoutMs = AVAILABILITY_CHECK_TIMEOUT_MS } = {}): Promise<TunnelAvailability> {
  const target = resolveExecutableLaunchTarget('ngrok');
  if (target) {
    try {
      const result = spawnSync(target.command, ['version'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: target.env,
        timeout: timeoutMs,
      });
      if (result.status === 0) {
        return { available: true, path: target.command, version: result.stdout.trim() || result.stderr.trim() };
      }
    } catch {
      return { available: false, path: null, version: null };
    }
  }
  return { available: false, path: null, version: null };
}

export async function checkNgrokAuthtokenConfigured(ngrokPath: string | null = null, { timeoutMs = AVAILABILITY_CHECK_TIMEOUT_MS } = {}) {
  if (process.env.NGROK_AUTHTOKEN !== undefined && process.env.NGROK_AUTHTOKEN.trim().length > 0) {
    return { configured: true, detail: 'NGROK_AUTHTOKEN is set.' };
  }

  const target = ngrokPath
    ? { command: ngrokPath, env: createExecutableSearchEnv() }
    : resolveExecutableLaunchTarget('ngrok');
  if (!target) {
    return { configured: false, detail: getNgrokInstallInfo().message };
  }

  try {
    const result = spawnSync(target.command, ['config', 'check'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: target.env,
      timeout: timeoutMs,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.status === 0) {
      return { configured: true, detail: output || 'ngrok config is valid.' };
    }
    return { configured: false, detail: output || NGROK_AUTHTOKEN_HELP };
  } catch (error) {
    return {
      configured: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkNgrokApiReachability({ fetchImpl = globalThis.fetch, timeoutMs = 5000 }: TunnelReachabilityOptions = {}) {
  if (!isFetch(fetchImpl)) {
    return { reachable: false, status: null, error: 'Fetch API is unavailable in this runtime.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://api.ngrok.com/', {
      method: 'GET',
      signal: controller.signal,
    });
    return { reachable: true, status: response.status, error: null };
  } catch (error) {
    return {
      reachable: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

const spawnNgrok = (args: string[], resolvedBinaryPath = 'ngrok') => spawn(resolvedBinaryPath, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: createExecutableSearchEnv(),
  killSignal: 'SIGINT',
});

const normalizeNgrokPublicUrl = (value: string | null | undefined) => {
  if (!isText(value) || value.trim().length === 0) {
    return null;
  }
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' && parsed.hostname.includes('ngrok')) {
      return parsed.toString().replace(/\/$/, '');
    }
  } catch {
    return null;
  }
  return null;
};

export function extractNgrokPublicUrlFromText(text: string) {
  if (text.trim().length === 0) {
    return null;
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const parsed = readNgrokLog(line);
    const parsedUrl = parsed
      ? normalizeNgrokPublicUrl(isText(parsed.url) ? parsed.url : undefined)
        || normalizeNgrokPublicUrl(isText(parsed.public_url) ? parsed.public_url : undefined)
      : null;
    if (parsedUrl) {
      return parsedUrl;
    }

    const match = line.match(NGROK_PUBLIC_URL_REGEX);
    const matchedUrl = normalizeNgrokPublicUrl(match?.[0]);
    if (matchedUrl) {
      return matchedUrl;
    }
  }

  return null;
}

const normalizeNgrokDiagnosticText = (value: string) => {
  return value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
};

export const summarizeNgrokOutput = (lines: string[]) => {
  const nonEmptyLines = Array.isArray(lines)
    ? lines.map((line) => String(line || '').trim()).filter(Boolean)
    : [];
  if (nonEmptyLines.length === 0) {
    return '';
  }

  for (const line of [...nonEmptyLines].reverse()) {
    const parsed = readNgrokLog(line);
    if (!parsed) continue;
    const level = isText(parsed.lvl) ? parsed.lvl.toLowerCase() : '';
    if (level !== 'eror' && level !== 'error' && level !== 'crit') {
      continue;
    }
    const err = isText(parsed.err) ? normalizeNgrokDiagnosticText(parsed.err) : '';
    if (err && err !== '<nil>') {
      return err;
    }
  }

  for (const line of [...nonEmptyLines].reverse()) {
    const parsed = readNgrokLog(line);
    if (!parsed) continue;
    const err = isText(parsed.err) ? normalizeNgrokDiagnosticText(parsed.err) : '';
    if (err && err !== '<nil>' && !/context canceled/i.test(err)) {
      return err;
    }
    const msg = isText(parsed.msg) ? normalizeNgrokDiagnosticText(parsed.msg) : '';
    if (msg && /failed|error|invalid|auth/i.test(msg)) {
      return msg;
    }
  }

  const errorLines = nonEmptyLines
    .filter((line) => /^ERROR:/i.test(line))
    .map((line) => normalizeNgrokDiagnosticText(line.replace(/^ERROR:\s*/i, '')))
    .filter(Boolean);
  if (errorLines.length > 0) {
    return errorLines.slice(0, 4).join(' ');
  }

  const lastLine = [...nonEmptyLines].reverse().find((line) => line.trim().length > 0);
  if (!lastLine) {
    return '';
  }
  const parsed = readNgrokLog(lastLine);
  if (parsed && isText(parsed.err) && parsed.err.trim().length > 0) {
    return normalizeNgrokDiagnosticText(parsed.err);
  }
  if (parsed && isText(parsed.msg) && parsed.msg.trim().length > 0) {
    return normalizeNgrokDiagnosticText(parsed.msg);
  }
  return normalizeNgrokDiagnosticText(lastLine);
};

const appendNgrokOutputSummary = (message: string, lines: string[]) => {
  const summary = summarizeNgrokOutput(lines);
  return summary ? `${message}: ${summary}` : message;
};

export async function fetchNgrokPublicUrl({ fetchImpl = globalThis.fetch, timeoutMs = NGROK_POLL_TIMEOUT_MS, signal }: { fetchImpl?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}) {
  if (!isFetch(fetchImpl)) {
    return null;
  }
  // One controller carries both the deadline and the caller's signal, so
  // either aborts the fetch -- including a bounded body read that
  // is still in flight when the deadline (or the caller) fires. The timer
  // is only cleared after the body read settles, in finally.
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else if (signal) {
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(NGROK_API_URL, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await readBoundedResponseJson(response, NGROK_TUNNELS_RESPONSE_MAX_BYTES);
    const tunnels: unknown[] = hasTunnels(payload) && Array.isArray(payload.tunnels) ? payload.tunnels : [];
    const httpsTunnel = tunnels.find((entry): entry is NgrokTunnel =>
      isNgrokTunnel(entry) && entry.proto === 'https' && isText(entry.public_url) && Boolean(normalizeNgrokPublicUrl(entry.public_url)));
    const fallbackTunnel = tunnels.find((entry): entry is NgrokTunnel =>
      isNgrokTunnel(entry) && isText(entry.public_url) && Boolean(normalizeNgrokPublicUrl(entry.public_url)));
    return normalizeNgrokPublicUrl(isText(httpsTunnel?.public_url) ? httpsTunnel.public_url : undefined)
      || normalizeNgrokPublicUrl(isText(fallbackTunnel?.public_url) ? fallbackTunnel.public_url : undefined);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    if (signal) {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export function pollNgrokPublicUrl({ fetchImpl, timeoutMs = NGROK_POLL_TIMEOUT_MS, intervalMs = NGROK_POLL_INTERVAL_MS, getPublicUrl, onPublicUrl }: {
  fetchImpl?: unknown;
  timeoutMs?: number;
  intervalMs?: number;
  getPublicUrl?: () => string | null;
  onPublicUrl?: (url: string) => void;
} = {}) {
  let stopped = false;
  let inFlight = false;
  let currentController: AbortController | null = null;

  const tick = async () => {
    if (stopped) {
      return;
    }
    // Check the captured URL before the in-flight guard: child output can
    // supply the URL while a poll fetch is stalled, and it must resolve
    // startup promptly instead of waiting out that attempt (or the 30 s
    // startup timeout firing first).
    const existing = isFunction(getPublicUrl) ? getPublicUrl() : null;
    if (existing) {
      onPublicUrl?.(existing);
      return;
    }
    if (inFlight) {
      return;
    }
    inFlight = true;
    const controller = new AbortController();
    currentController = controller;
    try {
      const fetched = await fetchNgrokPublicUrl({ fetchImpl, timeoutMs, signal: controller.signal });
      const resolved = (isFunction(getPublicUrl) ? getPublicUrl() : null) || fetched;
      if (resolved && !stopped) {
        onPublicUrl?.(resolved);
      }
    } catch {
      // fetchNgrokPublicUrl already settles failures as null; defensive only.
    } finally {
      inFlight = false;
      if (currentController === controller) {
        currentController = null;
      }
    }
  };

  const timer = setInterval(tick, intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      currentController?.abort();
    },
  };
}

export async function startNgrokQuickTunnel({ port }: { port?: number | null | undefined }) {
  const ngrokCheck = await checkNgrokAvailable();
  if (!ngrokCheck.available) {
    throw new Error(getNgrokInstallInfo().message);
  }

  const authtokenCheck = await checkNgrokAuthtokenConfigured(ngrokCheck.path);
  if (!authtokenCheck.configured) {
    throw new Error(`ngrok authtoken is not configured. ${authtokenCheck.detail || NGROK_AUTHTOKEN_HELP}`);
  }

  if (!Number.isFinite(port)) {
    throw new Error('A local port is required to start an ngrok tunnel');
  }

  const child = spawnNgrok(['http', '--log=stdout', '--log-format=json', `127.0.0.1:${port}`], ngrokCheck.path);
  let publicUrl: string | null = null;
  const recentOutput: string[] = [];

  // Extraction and diagnostics run over complete lines only: a chunk that
  // ends mid-URL or mid-log-line contributes nothing until the rest of the
  // line arrives, so a fragment can never be captured as the tunnel URL or
  // stored as a diagnostics line.
  const captureLines = (lines: string[]) => {
    const parsedUrl = extractNgrokPublicUrlFromText(lines.join('\n'));
    if (parsedUrl) {
      publicUrl = parsedUrl;
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      recentOutput.push(trimmed);
      if (recentOutput.length > 200) {
        recentOutput.shift();
      }
    }
  };

  const stdoutAccumulator = createBoundedOutputAccumulator();
  const stderrAccumulator = createBoundedOutputAccumulator();

  child.stdout.on('data', (chunk) => {
    captureLines(stdoutAccumulator.push(chunk).lines);
  });
  child.stdout.on('end', () => {
    captureLines(stdoutAccumulator.flush());
  });

  child.stderr.on('data', (chunk) => {
    const { decoded, lines } = stderrAccumulator.push(chunk);
    captureLines(lines);
    process.stderr.write(decoded);
  });
  child.stderr.on('end', () => {
    captureLines(stderrAccumulator.flush());
  });

  await new Promise<null>((resolve, reject) => {
    let settled = false;
    let poller: ReturnType<typeof pollNgrokPublicUrl> | null = null;
    const finish = <T>(handler: (value: T) => void, value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      // Abort (not just stop polling) so no poll fetch stays pending
      // after the startup promise settles for any reason.
      poller?.stop();
      child.off('error', onError);
      child.off('exit', onExit);
      handler(value);
    };

    const timeout = setTimeout(() => {
      interruptTunnelProcess(child);
      finish(reject, new Error(appendNgrokOutputSummary('Ngrok tunnel URL not received within 30 seconds', recentOutput)));
    }, DEFAULT_STARTUP_TIMEOUT_MS);

    poller = pollNgrokPublicUrl({
      getPublicUrl: () => publicUrl,
      onPublicUrl: (url: string) => {
        publicUrl = url;
        finish(resolve, null);
      },
    });

    const onError = (error: Error) => {
      finish(reject, new Error(`Ngrok failed to start: ${error.message}`));
    };

    const onExit = (code: number | null) => {
      // 'exit' can fire before stdout/stderr emit 'end', so flush both
      // held final unterminated lines here; ngrok logs to stdout
      // (--log=stdout), so that line is its diagnostic record. flush()
      // clears each accumulator, so the later 'end' handlers cannot
      // capture a line a second time (#1767 stdout; #1693 stderr).
      captureLines(stdoutAccumulator.flush());
      captureLines(stderrAccumulator.flush());
      finish(reject, new Error(appendNgrokOutputSummary(`Ngrok exited while starting (code ${code ?? 'unknown'})`, recentOutput)));
    };

    child.once('error', onError);
    child.once('exit', onExit);
  });

  return {
    mode: 'quick',
    stop: () => {
      interruptTunnelProcess(child);
    },
    process: child,
    getPublicUrl: () => publicUrl,
  };
}
