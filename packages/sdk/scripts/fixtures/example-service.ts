import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

// Starts an example's service bundle the way OpenChamber does: a loopback
// port and a bearer in the environment, then `/health` until it answers.
//
// The port is picked by listening on 0 and closing, so another process can
// take it before the service binds it. The service then exits with
// EADDRINUSE, and whatever holds the port may accept the probe and never
// answer it, so a probe ends when the service exits or the deadline passes.
// A port taken that way is retried on a fresh one. Any other exit, or a
// service that never answers, fails with what it printed instead of leaving
// the caller's hook to time out with no reason.

const PORT_ATTEMPTS = 3;
const READY_DEADLINE_MS = 3_000;
const POLL_INTERVAL_MS = 25;

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = Object(server.address());
    server.close(() => resolve(Number(port)));
  });
});

const answersHealth = (port: number, token: string, signal: AbortSignal) => fetch(`http://127.0.0.1:${port}/health`, {
  headers: { authorization: `Bearer ${token}` },
  signal,
}).then((response) => response.ok, () => false);

export const startExampleService = async ({ entry, token, env = {} }: {
  entry: string,
  token: string,
  env?: Record<string, string>,
}): Promise<{ service: ChildProcess, port: number }> => {
  for (let attempt = 1; attempt <= PORT_ATTEMPTS; attempt += 1) {
    const port = await freePort();
    const service = spawn('node', [entry], {
      env: {
        PATH: process.env.PATH,
        OPENCHAMBER_SERVICE_PORT: String(port),
        OPENCHAMBER_SERVICE_TOKEN: token,
        ...env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    service.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    // `close` rather than `exit`: it comes once stderr is read to the end.
    const closed = new AbortController();
    service.once('close', () => { closed.abort(); });

    const deadline = AbortSignal.timeout(READY_DEADLINE_MS);
    const probe = AbortSignal.any([closed.signal, deadline]);
    while (!probe.aborted) {
      if (await answersHealth(port, token, probe)) return { service, port };
      await new Promise((resolve) => { setTimeout(resolve, POLL_INTERVAL_MS); });
    }
    if (!closed.signal.aborted) {
      service.kill();
      throw new Error(`${entry} did not answer /health within ${READY_DEADLINE_MS} ms.\n${stderr}`);
    }
    if (!stderr.includes('EADDRINUSE')) throw new Error(`${entry} exited before it became ready.\n${stderr}`);
  }
  throw new Error(`${entry} found its port taken ${PORT_ATTEMPTS} times in a row.`);
};
