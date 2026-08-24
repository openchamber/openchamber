import crypto from 'node:crypto';
import { reauthBodyHash } from './identity.js';

/**
 * Who may ask for a privileged workspace operation.
 *
 * Capability decides, and a tunnel or unknown-public request is refused before
 * credentials are considered. Only changing the policy asks for a second credential —
 * see {@link createWorkspaceAuthorization} for why.
 */
export function createWorkspaceAuthorization({ uiAuthController, tunnelAuthController, getWorkspaceRuntimeBoundary }) {
  function principalFor(context) {
    if (context?.type === 'client' && context.clientId) return `client:${context.clientId}`;
    if (context?.type === 'session' && context.token) return `session:${crypto.createHash('sha256').update(context.token).digest('hex')}`;
    return null;
  }

  function requireSupportedBoundary(res) {
    const boundary = getWorkspaceRuntimeBoundary();
    if (boundary?.supported !== false) return true;
    res.status(501).json({ error: boundary.error || 'Secure Workspace management is unavailable for this OpenCode runtime', diagnostics: boundary.diagnostics ?? [] });
    return false;
  }

  /**
   * A host UI session or a client holding the capability, and never a request arriving
   * over a tunnel.
   *
   * It deliberately does not ask for the password again. Nothing that this feature exists
   * to contain can reach these endpoints: the workspace network is created `--internal`,
   * so the runtime has no route to the host at all, and a tunnel request is refused above
   * regardless of credentials. What remained was a prompt that a person answered on their
   * own machine, in front of a screen listing exactly what they had asked for — and asked
   * often enough that it stopped being read, which costs more than it defends. Changing
   * the policy itself still asks; see {@link authorizePolicyChange}.
   */
  async function authorizeAdminRequest(req, res, capability) {
    if (!requireSupportedBoundary(res)) return false;
    if (!uiAuthController?.resolveAuthContext) {
      res.status(500).json({ error: 'Workspace authorization is unavailable' });
      return false;
    }
    const context = await uiAuthController.resolveAuthContext(req, res, { allowClientAuth: true, allowUrlToken: false });
    if (!context) {
      res.status(401).json({ error: 'Authentication required' });
      return false;
    }
    const capabilities = Array.isArray(context.client?.capabilities) ? context.client.capabilities : [];
    const requestScope = tunnelAuthController?.classifyRequestScope?.(req);
    if (context.type === 'session' && (requestScope === 'tunnel' || requestScope === 'unknown-public')) {
      res.status(403).json({ error: 'Host workspace administration requires a host UI session' });
      return false;
    }
    if (context.type !== 'session' && !capabilities.includes(capability)) {
      res.status(403).json({ error: `Client capability required: ${capability}`, requiredCapability: capability });
      return false;
    }
    return true;
  }

  /**
   * The same authorization, plus a single-use proof bound to the exact submitted body.
   *
   * Reserved for changing the Secure Workspace policy, which is the one operation that
   * operates on the protections rather than within them: it can widen the egress
   * allowlist, change the runtime image, or switch the feature off. Every other action
   * shows what it will do before doing it — this one takes effect quietly and stays in
   * effect, so it is worth the interruption.
   */
  async function authorizePolicyChange(req, res, capability, operation, project, payload) {
    if (!await authorizeAdminRequest(req, res, capability)) return false;
    if (!uiAuthController?.consumeReauthProof) {
      res.status(500).json({ error: 'Workspace authorization is unavailable' });
      return false;
    }
    const validProof = await uiAuthController.consumeReauthProof(req, { operation, project, bodyHash: reauthBodyHash(payload) });
    if (!validProof) {
      res.status(428).json({ error: 'Reauthentication required', reauthRequired: true, operation, project });
      return false;
    }
    return true;
  }

  /** Authorization for capability-only reads and session use; returns the principal. */
  async function authorizeCapabilityRequest(req, res, capability, { allowUnsupported = false } = {}) {
    if (!allowUnsupported && !requireSupportedBoundary(res)) return null;
    if (!uiAuthController?.resolveAuthContext) {
      res.status(500).json({ error: 'Workspace authorization is unavailable' });
      return null;
    }
    const context = await uiAuthController.resolveAuthContext(req, res, { allowClientAuth: true, allowUrlToken: false });
    if (!context) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    const capabilities = Array.isArray(context.client?.capabilities) ? context.client.capabilities : [];
    const requestScope = tunnelAuthController?.classifyRequestScope?.(req);
    if (context.type === 'session' && (requestScope === 'tunnel' || requestScope === 'unknown-public')) {
      res.status(403).json({ error: 'Workspace access requires a capability-scoped client' });
      return null;
    }
    if (context.type !== 'session' && !capabilities.includes(capability)) {
      res.status(403).json({ error: `Client capability required: ${capability}`, requiredCapability: capability });
      return null;
    }
    const principal = principalFor(context);
    if (!principal) {
      res.status(401).json({ error: 'Authenticated principal is required' });
      return null;
    }
    return { context, principal };
  }

  return { principalFor, requireSupportedBoundary, authorizeAdminRequest, authorizePolicyChange, authorizeCapabilityRequest };
}
