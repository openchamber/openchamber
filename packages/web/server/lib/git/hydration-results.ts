import { isString } from '../shared/object-guards.js';
import { parseSubmoduleManifest } from './submodule-discovery.js';
import { normalizeDiscoveryEndpoint, resolveGitRelativeEndpoint } from './discovery-endpoint.js';
import { isRelativeCheckoutPath } from './network-operation-registry.js';
import type { CheckoutHydrationFailure, HydrationFailure } from './network-execution-contracts.js';
import type { HydrationInspection, HydrationTransfer } from './network-plan-contracts.js';

type HydrationErrorFields = {
  code?: unknown;
  cancelled?: unknown;
  timedOut?: unknown;
  submodulePath?: unknown;
};

const hasErrorFields = (value: unknown): value is HydrationErrorFields => value !== null && value !== undefined;

const scopedSubmodulePath = (modulePath: string, prefix: string) => {
  const candidate = prefix ? `${prefix}/${modulePath}` : modulePath;
  if (isRelativeCheckoutPath(candidate)) return candidate;
  return isRelativeCheckoutPath(prefix) ? prefix : '.';
};

export function parseHydrationSubmodules(input: Parameters<typeof parseSubmoduleManifest>[0], prefix = '') {
  try {
    return parseSubmoduleManifest(input);
  } catch (error) {
    if (hasErrorFields(error) && isString(error.submodulePath)) {
      error.submodulePath = scopedSubmodulePath(error.submodulePath, prefix);
    }
    throw error;
  }
}

export function resolveHydrationSubmodule(module: { path: string; url: string }, parentEndpoint: string, prefix = '') {
  normalizeDiscoveryEndpoint(parentEndpoint, { ownRemote: true, trailingSlash: true });
  try {
    return resolveGitRelativeEndpoint(module.url, parentEndpoint, { trailingSlash: true });
  } catch (error) {
    if (hasErrorFields(error)) Object.assign(error, { code: 'INVALID_SUBMODULE_MANIFEST', submodulePath: scopedSubmodulePath(module.path, prefix) });
    throw error;
  }
}

export function hydrationError(cause: unknown): HydrationFailure {
  const error = hasErrorFields(cause) ? cause : undefined;
  if (error?.code === 'RUNTIME_UNSUPPORTED') {
    return { status: 'failed', error: { code: 'RUNTIME_UNSUPPORTED', message: 'Checkout hydration transport is unavailable' } };
  }
  if (error?.cancelled || error?.timedOut || error?.code === 'CANCELLED' || error?.code === 'TIMEOUT') {
    const timedOut = error?.timedOut || error?.code === 'TIMEOUT';
    return { status: 'cancelled', error: { code: timedOut ? 'TIMEOUT' : 'CANCELLED', message: timedOut ? 'Checkout hydration timed out' : 'Checkout hydration was cancelled' } };
  }
  if (error?.code === 'GIT_AUXILIARY_AUTHORIZATION_REQUIRED') {
    return { status: 'authorization-required', error: { code: 'AUTHENTICATION_REQUIRED', message: 'This checkout endpoint requires an explicit credential grant' } };
  }
  if (error?.code === 'SOURCE_CONTROL_BINDING_STALE') {
    return { status: 'failed', error: { code: 'STALE_BINDING', message: 'Source control binding changed' } };
  }
  if (error?.code === 'LFS_DISCOVERY_LIMIT_EXCEEDED') {
    return { status: 'invalid', error: { code: 'CHECKOUT_TOO_LARGE', message: 'Checkout has too many files to inspect' } };
  }
  if (String(error?.code || '').includes('INVALID') || String(error?.code || '').includes('LIMIT_EXCEEDED')
    || error?.code === 'UNSAFE_LFS_EXECUTABLE_CONFIG') {
    return { status: 'invalid', error: { code: 'INVALID_REQUEST', message: 'Checkout hydration configuration is invalid' } };
  }
  return { status: 'failed', error: { code: 'TRANSPORT_FAILED', message: 'Checkout hydration failed' } };
}

export function hydrationFailure(cause: unknown): CheckoutHydrationFailure {
  const error = hasErrorFields(cause) ? cause : undefined;
  const submodule = error?.code === 'INVALID_SUBMODULE_MANIFEST' && error.submodulePath !== undefined;
  const part = { path: submodule && isRelativeCheckoutPath(error.submodulePath) ? error.submodulePath : '.', ...hydrationError(error) };
  return Object.freeze({ status: part.status, submodules: submodule ? [part] : [], lfs: submodule ? [] : [part] });
}

export async function inspectForHydrationPlan<Input, Inspection extends { headSha: string }>(
  inspect: (input: Input) => Promise<Inspection>, input: Input, expectedHeadSha: string,
): Promise<{ inspection: Inspection | { headSha: string; requirements: []; transfers: []; sourceRequired: false }; preparedHydrationFailure?: CheckoutHydrationFailure }> {
  try {
    return { inspection: await inspect(input) };
  } catch (error) {
    const preparedHydrationFailure = hydrationFailure(error);
    if (!preparedHydrationFailure.submodules.length) throw error;
    return { inspection: { headSha: expectedHeadSha, requirements: [], transfers: [], sourceRequired: false }, preparedHydrationFailure };
  }
}

export function withDerivedFromRemote<Target extends object>(target: Target, derivedFromRemote: string | undefined): Target & { derivedFromRemote?: string } {
  if (!derivedFromRemote) return target;
  return Object.assign(target, { derivedFromRemote });
}

export function checkoutAuxiliaryOf(inspection: HydrationInspection, kind: HydrationTransfer['kind'], path: string) {
  const requirement = inspection.requirements.find((entry) => entry.kind === kind && entry.path === path);
  const transfer = inspection.transfers.find((entry) => entry.kind === kind && entry.path === path);
  if (!requirement || !transfer) return requirement ?? null;
  return withDerivedFromRemote({ ...requirement, rawEndpoint: transfer.rawEndpoint }, transfer.derivedFromRemote);
}
