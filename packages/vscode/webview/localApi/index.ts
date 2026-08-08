import type { LocalApiRouteHandler } from './types';
import { handleSystemRoutes } from './routes/system';
import { handleSessionsRoutes } from './routes/sessions';
import { handlePermissionRoutes } from './routes/permission';
import { handleMediaRoutes } from './routes/media';
import { handleHealthRoutes } from './routes/health';
import { handleFsRoutes } from './routes/fs';
import { handleConfigRoutes } from './routes/config';
import { handleFallbackRoutes } from './routes/fallback';

const ROUTE_HANDLERS: LocalApiRouteHandler[] = [
  handleSystemRoutes,
  handleSessionsRoutes,
  handlePermissionRoutes,
  handleMediaRoutes,
  handleHealthRoutes,
  handleFsRoutes,
  handleConfigRoutes,
  handleFallbackRoutes,
];

export const handleLocalApiRequest = async (
  input: RequestInfo | URL,
  url: URL,
  init: RequestInit | undefined,
  method: string,
): Promise<Response | null> => {
  const pathname = url.pathname;
  const normalizedPathname = pathname !== '/' ? pathname.replace(/\/+$/, '') : pathname;
  const ctx = { input, url, init, method, pathname, normalizedPathname };

  for (const handler of ROUTE_HANDLERS) {
    const response = await handler(ctx);
    if (response) {
      return response;
    }
  }

  return null;
};
