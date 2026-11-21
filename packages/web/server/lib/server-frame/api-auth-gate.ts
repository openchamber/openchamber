import { NOTIFICATION_EMIT_PATH } from '../notifications/emit-route.js';
import type { Request, RequestHandler } from '../shared/http-contracts.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';
import type { createTunnelAuth } from '../tunnels/tunnel-auth.js';

const selfAuthenticatedApiPaths = new Set(['/api/git/repository-credential']);

const isGuestOauthCallback = (req: Request) => (
  req.method === 'GET'
  && /^\/(?:guests\/[a-z][a-z0-9-]*|tracker\/ext-[a-z][a-z0-9-]*)\/oauth\/callback$/.test(req.path || '')
);

const isMcpOauthCallback = (req: Request) => (
  req.method === 'GET'
  && /^\/mcp\/oauth\/[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\/callback$/.test(req.path || '')
);

const isFilePreviewRead = (req: Request) => (
  req.method === 'GET'
  && /^\/fs\/preview\/[^/]+\/./.test(req.path || '')
);

const isGuestFrameFileRead = (req: Request) => (
  req.method === 'GET'
  && /^\/guest-files\/[^/]+\/./.test(req.path || '')
);

export const isRouteGatedApiRequest = (req: Request) => (
  req.method === 'POST' && (req.originalUrl || '').split('?', 1).join('') === NOTIFICATION_EMIT_PATH
);

export const createApiAuthGate = ({ tunnelAuthController, uiAuthController }: {
  tunnelAuthController: ReturnType<typeof createTunnelAuth>;
  uiAuthController: ReturnType<typeof createUiAuth>;
}): RequestHandler => async (req, res, next) => {
  const pathname = (req.originalUrl || '').split('?', 1).join('');
  if (selfAuthenticatedApiPaths.has(pathname)) return next();
  if (isGuestOauthCallback(req) || isMcpOauthCallback(req) || isFilePreviewRead(req) || isGuestFrameFileRead(req)) {
    return next();
  }
  const requestScope = tunnelAuthController.classifyRequestScope(req);
  if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
    return tunnelAuthController.requireTunnelSession(req, res, next);
  }
  return uiAuthController.requireAuth(req, res, next);
};
