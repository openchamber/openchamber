import { startAuthentication, WebAuthnError, type AuthenticationResponseJSON } from '@simplewebauthn/browser';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import {
  completeRootPasskeyApproval, createSpace, requestRootActivation, requestRootPasskeyApprovalChallenge,
  requestRootStartActivation, restartSpace, SpacesRequestError, startSpace, type CreateSpaceRequest,
} from './spaces-api';
import type { RootActivationChallenge, RootPasskeyChallenge } from './root-passkey-schemas';
import { confirmRootStart } from './root-start-confirmation';

export type RootPasskeyDependencies = {
  readonly authenticate: typeof startAuthentication;
  readonly origin: () => string;
};
const browserPasskeys: RootPasskeyDependencies = {
  authenticate: startAuthentication,
  origin: () => window.location.origin,
};

/** Exact origins only. Loopback aliases, ports and remote-shell origins are distinct. */
const requireRootOrigin = (origins: readonly string[], origin: string): void => {
  if (origins.length === 0) throw new SpacesRequestError('no_passkey_approved', '', 0);
  if (!origins.includes(origin)) {
    throw new SpacesRequestError('root_activation_origin', origins.join(', '), 0);
  }
};

/** A runtime switch during a native prompt must never send its assertion to another server. */
const captureRuntime = () => {
  const isCurrentRuntime = captureRuntimeInstance();
  return () => {
    if (!isCurrentRuntime()) {
      throw new SpacesRequestError('root_activation_challenge_unknown', '', 0);
    }
  };
};

const authenticate = async (options: RootPasskeyChallenge, authenticatePasskey: typeof startAuthentication): Promise<AuthenticationResponseJSON> => {
  try {
    return await authenticatePasskey({ optionsJSON: {
      challenge: options.challenge, rpId: options.rpID, userVerification: 'required',
      allowCredentials: options.allowCredentials.map(({ id }) => ({ id, type: 'public-key' })),
    } });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const cancelled = error.name === 'NotAllowedError' || error.name === 'AbortError'
      || (error instanceof WebAuthnError && (error.code === 'ERROR_CEREMONY_ABORTED' || error.cause instanceof Error && error.cause.name === 'NotAllowedError'));
    throw new SpacesRequestError(cancelled ? 'root_activation_cancelled' : 'root_activation_refused', '', 0);
  }
};

const authenticateRootActivation = (options: RootActivationChallenge, dependencies: RootPasskeyDependencies = browserPasskeys): Promise<AuthenticationResponseJSON> => {
  const currentOrigin = dependencies.origin();
  requireRootOrigin(options.allowCredentials.map(({ origin }) => origin), currentOrigin);
  // Never offer a credential approved for a different origin, even under the same rpID.
  return authenticate({ ...options, allowCredentials: options.allowCredentials.filter(({ origin }) => origin === currentOrigin) }, dependencies.authenticate);
};

export const createRootSpace = async (request: CreateSpaceRequest, origins: readonly string[], dependencies: RootPasskeyDependencies = browserPasskeys) => {
  requireRootOrigin(origins, dependencies.origin());
  const requireSameRuntime = captureRuntime();
  const options = await requestRootActivation({ op: 'create', request });
  requireSameRuntime();
  const rootActivation = await authenticateRootActivation(options, dependencies);
  requireSameRuntime();
  const entry = await createSpace({ ...request, spaceId: options.spaceId, rootActivation });
  requireSameRuntime();
  return entry;
};

export const startRootSpace = async (spaceId: string, action: 'start' | 'restart', dependencies: RootPasskeyDependencies = browserPasskeys) => {
  const requireSameRuntime = captureRuntime();
  if (!await confirmRootStart(spaceId)) throw new SpacesRequestError('root_activation_cancelled', '', 0);
  requireSameRuntime();
  const options = await requestRootStartActivation(spaceId);
  requireSameRuntime();
  const rootActivation = await authenticateRootActivation(options, dependencies);
  requireSameRuntime();
  return action === 'start' ? startSpace(spaceId, rootActivation) : restartSpace(spaceId, rootActivation);
};

export const approveRootPasskey = async (code: string, label: string, dependencies: RootPasskeyDependencies = browserPasskeys) => {
  const requireSameRuntime = captureRuntime();
  const options = await requestRootPasskeyApprovalChallenge(code);
  requireSameRuntime();
  const response = await authenticate(options, dependencies.authenticate);
  requireSameRuntime();
  return completeRootPasskeyApproval({ code, response, label: label.trim() || undefined });
};
