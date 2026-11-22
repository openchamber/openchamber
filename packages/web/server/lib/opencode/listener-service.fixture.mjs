// A stand-in OpenChamber service for listener-handoff.test.js. It listens through the same
// startup runtime the server uses, so an inherited socket (LISTEN_FDS/LISTEN_PID) is taken the
// same way, and it answers with its pid so the test can tell one service from its successor.
import http from 'node:http';

// The server is TypeScript run from source; this is the loader bin/cli.js installs for it.
await import('../../../scripts/register-server-sources.mjs');
const { createServerStartupRuntime } = await import('../server-frame/server-startup-runtime.js');

const server = http.createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ pid: process.pid }));
});

const runtime = createServerStartupRuntime({
  process,
  crypto: {},
  server,
  gracefulShutdown: async () => {},
  getSignalsAttached: () => true,
  setSignalsAttached: () => {},
  syncToHmrState: () => {},
});

await runtime.startListeningAndMaybeTunnel({
  port: Number(process.env.LISTENER_FIXTURE_PORT),
  bindHost: '127.0.0.1',
});

// SIGTERM is the unit stopping this service: stop accepting, let open requests finish, exit.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
