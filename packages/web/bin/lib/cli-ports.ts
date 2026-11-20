import net from 'net';
import { DEFAULT_PORT } from './cli-args.js';
import { fetchSystemInfoFromPort } from './cli-http.js';
import type { CliNotice } from './cli-process.js';
import type { JsonValue } from '../../server/lib/shared/json-values.js';

async function isPortAvailable(port: number | undefined, host?: JsonValue) {
  if (port === undefined || !Number.isFinite(port) || port <= 0) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen({ port, host }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function resolveAvailablePort(desiredPort: number | undefined, explicitPort = false, onNotice?: (notice: CliNotice) => void) {
  const startPort = desiredPort !== undefined && Number.isFinite(desiredPort) ? Math.trunc(desiredPort) : DEFAULT_PORT;
  if (explicitPort) {
    return startPort;
  }
  if (await isPortAvailable(startPort)) {
    return startPort;
  }

  const occupant = await fetchSystemInfoFromPort(startPort);
  let message;
  if (occupant?.runtime === 'desktop') {
    message = `Port ${startPort} is used by OpenChamber Desktop; using a free port`;
  } else if (occupant?.runtime) {
    message = `Port ${startPort} is used by an existing OpenChamber instance; using a free port`;
  } else {
    message = `Port ${startPort} in use; using a free port`;
  }
  if (onNotice !== undefined && message) {
    onNotice({
      level: 'warning',
      code: 'PORT_REASSIGNED',
      message,
    });
  } else if (message) {
    console.warn(message);
  }
  return 0;
}


export { isPortAvailable, resolveAvailablePort };
