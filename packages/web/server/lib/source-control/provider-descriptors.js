import { githubDescriptor } from '../github/descriptor.js';
import { gitlabDescriptor } from '../gitlab/descriptor.js';
import { giteaDescriptor } from '../gitea/descriptor.js';
import { isProviderId, isReservedProviderId } from './provider-id.js';

/**
 * The built-in source-control providers in priority order: where two could
 * answer the same question (a remote both could own), the earlier one does.
 * Descriptors are static and SDK-free, so the Git layer, bindings and tracked
 * items read them synchronously; implementations load lazily through the
 * provider registry.
 */
const BUILT_IN_DESCRIPTORS = Object.freeze([githubDescriptor, gitlabDescriptor, giteaDescriptor]);
// Provider routes live at `/api/source-control/<id>/...`, beside the shell's
// own routes, so an id may not be one of those names.
const SHELL_ROUTE_NAMES = Object.freeze(['binding', 'instances', 'providers', 'repository-context']);

/** A descriptor facade over a list; the default instance serves the built-ins. */
export function createProviderDescriptors(descriptors = BUILT_IN_DESCRIPTORS) {
  const byId = new Map();
  for (const descriptor of descriptors) {
    if (!isProviderId(descriptor?.id) || isReservedProviderId(descriptor.id)
      || SHELL_ROUTE_NAMES.includes(descriptor.id) || byId.has(descriptor.id)) {
      throw new Error(`Source control provider id is invalid: ${String(descriptor?.id)}`);
    }
    byId.set(descriptor.id, descriptor);
  }
  const list = Object.freeze([...byId.values()]);
  return Object.freeze({
    get: (id) => byId.get(id) ?? null,
    has: (id) => byId.has(id),
    list: () => list,
  });
}

export const sourceControlProviderDescriptors = createProviderDescriptors();

/**
 * What a client reads about a provider (`GET /api/source-control/providers`):
 * plain JSON in the shape the UI registry parses, built from the descriptor's
 * own fields plus its `presentation` block. No functions, patterns, transport
 * policy or other server-only fields leave the server. `order` is the
 * registry's priority order.
 */
export function publicProviderDescriptor(descriptor, order) {
  const { presentation } = descriptor;
  const cli = descriptor.authMethods.cli;
  const methods = ['device', 'pat', 'cli'].filter((method) => Boolean(descriptor.authMethods[method]));
  const legacyFlow = descriptor.instances?.legacyFlow;
  const published = {
    id: descriptor.id,
    label: descriptor.label,
    order,
    terminology: {
      changeRequest: descriptor.terminology.changeRequest,
      changeRequestPrefix: descriptor.referencePrefix.changeRequest,
      issuePrefix: descriptor.referencePrefix.issue,
      sharedNumberSpace: presentation.sharedNumberSpace,
      abbreviation: presentation.abbreviation,
      promptNoun: presentation.promptNoun,
      ci: descriptor.terminology.ci,
    },
    icon: { ...presentation.icon },
    repository: { nestedNamespaces: descriptor.repositoryPath === 'namespace/name' },
    instances: {
      format: descriptor.instance.form,
      defaultInstance: descriptor.instance.defaultInstances[0] ?? null,
      multiple: presentation.instances.multiple,
      allowLoopbackHttp: presentation.instances.allowLoopbackHttp,
      allowPort: presentation.instances.allowPort,
      reserved: [...presentation.instances.reserved],
      placeholder: presentation.instances.placeholder,
    },
    auth: { methods, cliTransport: presentation.cliTransport },
    settings: {
      fields: descriptor.settings.map((field) => ({ id: field.key, kind: field.type, secret: field.secret })),
    },
    urls: {
      changeRequest: [...presentation.urls.changeRequest],
      issue: [...presentation.urls.issue],
    },
    features: {
      ...presentation.features,
      changeRequestTemplates: [...presentation.features.changeRequestTemplates],
    },
  };
  // Optional fields are left out, not sent empty, where a provider has none.
  if (legacyFlow) published.instances.legacyFlow = { instance: legacyFlow.instance, kind: legacyFlow.kind };
  if (cli) published.auth.cliName = cli.tool;
  if (presentation.token) {
    published.auth.token = { scopes: [...presentation.token.scopes] };
    if (presentation.token.createPath) published.auth.token.createPath = presentation.token.createPath;
  }
  return published;
}
