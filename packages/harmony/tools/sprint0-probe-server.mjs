import { networkInterfaces } from 'node:os';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
const DEFAULT_ALLOWED_ORIGIN = 'https://localhost';
const ORIGIN_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s]+$/;

export function isAllowedOrigin(origin, allowedOrigin) {
  return origin === allowedOrigin;
}

export function normalizeAllowedOrigin(value) {
  const normalized = String(value).trim().replace(/\/$/, '');

  if (!ORIGIN_PATTERN.test(normalized)) {
    throw new Error('The allowed origin must be an exact scheme://host value.');
  }

  return normalized;
}

function parsePort(value, { allowZero = false } = {}) {
  const rawPort = String(value).trim();
  const lowerBound = allowZero ? 0 : 1;
  const port = Number(rawPort);

  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < lowerBound || port > 65535) {
    throw new Error(`The port must be an integer from ${lowerBound} to 65535.`);
  }

  return port;
}

function readOptionValue(args, index, option) {
  const value = args[index + 1];

  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }

  return value;
}

export function parseProbeServerArgs(args) {
  const options = {
    allowedOrigin: DEFAULT_ALLOWED_ORIGIN,
    help: false,
    hostname: DEFAULT_HOST,
    port: DEFAULT_PORT,
  };

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];

    switch (option) {
      case '--host':
        options.hostname = readOptionValue(args, index, option).trim();
        index += 1;
        break;
      case '--port':
        options.port = readOptionValue(args, index, option);
        index += 1;
        break;
      case '--origin':
        options.allowedOrigin = readOptionValue(args, index, option);
        index += 1;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  if (!options.hostname) {
    throw new Error('The host cannot be empty.');
  }

  return {
    ...options,
    allowedOrigin: normalizeAllowedOrigin(options.allowedOrigin),
    port: parsePort(options.port),
  };
}

function corsHeaders(allowedOrigin) {
  return {
    'access-control-allow-headers': 'content-type, x-openchamber-probe',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-origin': allowedOrigin,
    'access-control-max-age': '0',
    'cache-control': 'no-store',
    vary: 'Origin',
  };
}

function jsonResponse(payload, allowedOrigin, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: {
      ...corsHeaders(allowedOrigin),
      'content-type': 'application/json; charset=utf-8',
    },
    status,
  });
}

function sseResponse(request, allowedOrigin) {
  const encoder = new TextEncoder();
  let heartbeat;

  const stream = new ReadableStream({
    cancel() {
      clearInterval(heartbeat);
    },
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) {
          return;
        }

        closed = true;
        clearInterval(heartbeat);
        controller.close();
      };

      request.signal.addEventListener('abort', close, { once: true });
      controller.enqueue(encoder.encode('data: {"type":"ready"}\n\n'));
      heartbeat = setInterval(() => {
        if (!closed) {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        }
      }, 1000);
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders(allowedOrigin),
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
    },
  });
}

export function createProbeServer({
  allowedOrigin = DEFAULT_ALLOWED_ORIGIN,
  hostname = DEFAULT_HOST,
  log = () => {},
  port = DEFAULT_PORT,
} = {}) {
  const exactOrigin = normalizeAllowedOrigin(allowedOrigin);
  const listenPort = parsePort(port, { allowZero: true });

  const server = Bun.serve({
    fetch(request, runtimeServer) {
      const requestUrl = new URL(request.url);
      const origin = request.headers.get('origin');
      const allowed = isAllowedOrigin(origin, exactOrigin);
      log(`${request.method} ${requestUrl.pathname} origin=${origin ?? '(missing)'} ${allowed ? 'accepted' : 'rejected'}`);

      if (!allowed) {
        return new Response('Origin rejected.', { status: 403 });
      }

      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders(exactOrigin), status: 204 });
      }

      if (requestUrl.pathname === '/health' && request.method === 'GET') {
        return jsonResponse({ ok: true, probe: 'health' }, exactOrigin);
      }

      if (requestUrl.pathname === '/echo' && request.method === 'POST') {
        return jsonResponse({ ok: true, probe: 'preflight' }, exactOrigin);
      }

      if (requestUrl.pathname === '/sse' && request.method === 'GET') {
        return sseResponse(request, exactOrigin);
      }

      if (requestUrl.pathname === '/ws' && request.method === 'GET') {
        if (runtimeServer.upgrade(request)) {
          return undefined;
        }

        return new Response('WebSocket upgrade failed.', { status: 500 });
      }

      return jsonResponse({ ok: false, probe: 'not-found' }, exactOrigin, 404);
    },
    hostname,
    port: listenPort,
    websocket: {
      message(socket, message) {
        if (message === 'ping') {
          socket.send('pong');
        }
      },
      open(socket) {
        socket.send('{"type":"ready"}');
      },
    },
  });

  return {
    allowedOrigin: exactOrigin,
    hostname,
    port: server.port,
    stop() {
      server.stop(true);
    },
  };
}

function usage() {
  return [
    'Usage: bun run harmony:probe-server -- [options]',
    '',
    'Options:',
    `  --host <host>       Bind address (default: ${DEFAULT_HOST})`,
    `  --port <port>       TCP port (default: ${DEFAULT_PORT})`,
    `  --origin <origin>   Exact browser Origin to allow (default: ${DEFAULT_ALLOWED_ORIGIN})`,
    '  -h, --help          Show this help',
  ].join('\n');
}

function advertisedUrls(hostname, port) {
  const urls = new Set();

  if (hostname !== '0.0.0.0') {
    urls.add(`http://${hostname}:${port}`);
  } else {
    urls.add(`http://127.0.0.1:${port}`);
  }

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.add(`http://${address.address}:${port}`);
      }
    }
  }

  return [...urls];
}

function run() {
  const options = parseProbeServerArgs(process.argv.slice(2));

  if (options.help) {
    console.info(usage());
    return;
  }

  const probeServer = createProbeServer({
    ...options,
    log(message) {
      console.info(`[harmony-probe] ${message}`);
    },
  });

  console.info(`[harmony-probe] allowed origin: ${probeServer.allowedOrigin}`);
  console.info('[harmony-probe] listener URLs:');
  for (const url of advertisedUrls(options.hostname, probeServer.port)) {
    console.info(`  ${url}`);
  }

  if (options.hostname === '0.0.0.0') {
    console.info('[harmony-probe] [LAN] This diagnostic endpoint is exposed only to your trusted local network.');
  }

  const stop = () => {
    probeServer.stop();
    process.exit(0);
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (import.meta.main) {
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown startup error.';
    console.error(`[harmony-probe] ${message}`);
    process.exitCode = 1;
  }
}
