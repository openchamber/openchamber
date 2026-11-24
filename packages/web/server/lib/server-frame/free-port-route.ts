import type { AddressInfo, Server } from 'node:net';
import type { Application, RequestHandler } from '../shared/http-contracts.js';

export const FREE_PORT_PATH = '/api/system/free-port';

export interface FreePortRouteDependencies {
  app: Application;
  requireAuth: RequestHandler;
}

const isAddressInfo = (value: ReturnType<Server['address']>): value is AddressInfo => Boolean(value) && typeof value === 'object';

const allocateLoopbackPort = async () => {
  const net = await import('node:net');
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      try {
        const address = server.address();
        const port = isAddressInfo(address) ? address.port : 0;
        server.close(() => {
          resolve(port);
        });
      } catch (error) {
        try {
          server.close();
        } catch {
          void 0;
        }
        reject(error);
      }
    });
  });
};

export const registerFreePortRoute = ({ app, requireAuth }: FreePortRouteDependencies) => {
  app.get(FREE_PORT_PATH, requireAuth, async (_req, res) => {
    try {
      const port = await allocateLoopbackPort();
      if (!Number.isFinite(port) || port <= 0) {
        return res.status(500).json({ error: 'Failed to allocate port' });
      }
      return res.json({ port });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to allocate port';
      return res.status(500).json({ error: message });
    }
  });
};
