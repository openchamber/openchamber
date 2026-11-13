import { createServer, type RequestListener } from 'node:http';
import { z } from 'zod';

const tcpAddressSchema = z.object({ port: z.number().int().min(1).max(65535) });

export const serveTestHttp = async (handler: RequestListener) => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = tcpAddressSchema.parse(server.address());
  return {
    url: new URL(`http://127.0.0.1:${address.port}/`),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};
