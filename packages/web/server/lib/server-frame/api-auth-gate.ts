import { NOTIFICATION_EMIT_PATH } from '../notifications/emit-route.js';
import { FREE_PORT_PATH } from './free-port-route.js';
import type { Request, RequestHandler } from '../shared/http-contracts.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';
import type { createTunnelAuth } from '../tunnels/tunnel-auth.js';

const selfAuthenticatedApiPaths = new Set(['/api/git/repository-credential']);

const requestPathname = (req: Request) => (req.originalUrl || '').split('?', 1).join('');

const routedApiPathname = (req: Request) => (req.baseUrl ? `/api${req.path}` : req.path);

const isGuestOauthCallback = (req: Request, pathname: string) => (
  req.method === 'GET'
  && /^\/api\/(?:guests\/[a-z][a-z0-9-]*|tracker\/ext-[a-z][a-z0-9-]*)\/oauth\/callback$/.test(pathname)
);

const isMcpOauthCallback = (req: Request, pathname: string) => (
  req.method === 'GET'
  && /^\/api\/mcp\/oauth\/[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\/callback$/.test(pathname)
);

const isFilePreviewRead = (req: Request, pathname: string) => (
  req.method === 'GET'
  && /^\/api\/fs\/preview\/[^/]+\/./.test(pathname)
);

const isGuestFrameFileRead = (req: Request, pathname: string) => (
  req.method === 'GET'
  && /^\/api\/guest-files\/[^/]+\/./.test(pathname)
);

const isFreePortRouteRequest = (req: Request, pathname: string) => (
  (req.method === 'GET' || req.method === 'HEAD')
  && pathname.replace(/\/$/, '').toLowerCase() === FREE_PORT_PATH
);

export const isRouteGatedApiRequest = (req: Request) => {
  const pathname = requestPathname(req);
  return (req.method === 'POST' && pathname === NOTIFICATION_EMIT_PATH)
    || isFreePortRouteRequest(req, pathname);
};

export const createApiAuthGate = ({ tunnelAuthController, uiAuthController }: {
  tunnelAuthController: ReturnType<typeof createTunnelAuth>;
  uiAuthController: ReturnType<typeof createUiAuth>;
}): RequestHandler => async (req, res, next) => {
  if (selfAuthenticatedApiPaths.has(requestPathname(req))) return next();
  const pathname = routedApiPathname(req);
  if (isGuestOauthCallback(req, pathname) || isMcpOauthCallback(req, pathname) || isFilePreviewRead(req, pathname) || isGuestFrameFileRead(req, pathname)) {
    return next();
  }
  const requestScope = tunnelAuthController.classifyRequestScope(req);
  if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
    return tunnelAuthController.requireTunnelSession(req, res, next);
  }
  return uiAuthController.requireAuth(req, res, next);
};
