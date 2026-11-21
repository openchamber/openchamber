import { githubDescriptor } from '../github/descriptor.js';
import { gitlabDescriptor } from '../gitlab/descriptor.js';
import { giteaDescriptor } from '../gitea/descriptor.js';
import { gerritDescriptor } from '../gerrit/descriptor.js';
import { forgejoDescriptor } from '../forgejo/descriptor.js';
import {
  EXTENSION_PROVIDER_PREFIX, isExtensionProviderId, isProviderId, isReservedProviderId,
} from './provider-id.js';
import type { ProviderDescriptor, ProviderId, PublicProviderDescriptor } from './provider-contract.js';

const BUILT_IN_DESCRIPTORS = Object.freeze([githubDescriptor, gitlabDescriptor, giteaDescriptor, gerritDescriptor, forgejoDescriptor]);

export const builtInDefaultHosts = Object.freeze(new Set(BUILT_IN_DESCRIPTORS.flatMap((descriptor) => (
  descriptor.instance.defaultInstances.map((instance) => new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(instance) ? instance : `https://${instance}`).hostname)
))));
const SHELL_ROUTE_NAMES = Object.freeze(['binding', 'instances', 'providers', 'repository-context']);

const invalidId = (id: ProviderId | null | undefined) => new Error(`Source control provider id is invalid: ${String(id)}`);

function assertChangeCapabilities(descriptor: ProviderDescriptor) {
  const { capabilities } = descriptor;
  const invalid = (what: string) => new Error(`Source control provider ${descriptor.id} has an invalid ${what}`);
  const methods = capabilities.merge ? capabilities.merge.methods : [];
  if (methods.includes('submit') && methods.length !== 1) throw invalid('merge method list: submit must be the only method');
  if (capabilities.reviewModel !== undefined && !['verdict', 'votes'].includes(capabilities.reviewModel)) throw invalid('review model');
  if (capabilities.revisions !== undefined && capabilities.revisions !== true && capabilities.revisions !== false) throw invalid('revisions capability');
  if (capabilities.draftConversion !== undefined && capabilities.draftConversion !== true && capabilities.draftConversion !== false) throw invalid('draft conversion capability');
  if (capabilities.createVia !== undefined && !['api', 'push'].includes(capabilities.createVia)) throw invalid('create method');
  if (capabilities.discussions !== undefined && capabilities.discussions !== true && capabilities.discussions !== false) throw invalid('discussions capability');
  if (capabilities.discussions && (!capabilities.referencePicker || !descriptor.presentation.urls.discussion?.length)) {
    throw invalid('discussions capability: it needs the reference picker and discussion URLs');
  }
}

export function createProviderDescriptors(descriptors: readonly ProviderDescriptor[] = BUILT_IN_DESCRIPTORS) {
  const byId = new Map<ProviderId, ProviderDescriptor>();
  for (const descriptor of descriptors) {
    if (!isProviderId(descriptor?.id) || isReservedProviderId(descriptor.id) || descriptor.id.startsWith(EXTENSION_PROVIDER_PREFIX)
      || SHELL_ROUTE_NAMES.includes(descriptor.id) || byId.has(descriptor.id)) {
      throw invalidId(descriptor?.id);
    }
    assertChangeCapabilities(descriptor);
    byId.set(descriptor.id, descriptor);
  }
  const fixed = [...byId.values()];
  const extensions = new Map<ProviderId, ProviderDescriptor>();
  let list = Object.freeze([...fixed]);
  const rebuild = () => {
    const attached = [...extensions.keys()].sort().map((id) => {
      const descriptor = extensions.get(id);
      if (descriptor === undefined) throw new Error('Registered extension descriptor is missing');
      return descriptor;
    });
    list = Object.freeze([...fixed, ...attached]);
  };
  return Object.freeze({
    get: (id: ProviderId) => byId.get(id) ?? extensions.get(id) ?? null,
    has: (id: ProviderId) => byId.has(id) || extensions.has(id),
    list: () => list,
    attachExtension: (descriptor: ProviderDescriptor) => {
      if (!isExtensionProviderId(descriptor?.id)) throw invalidId(descriptor?.id);
      assertChangeCapabilities(descriptor);
      extensions.set(descriptor.id, descriptor);
      rebuild();
    },
    detachExtension: (id: ProviderId) => {
      if (!extensions.delete(id)) return false;
      rebuild();
      return true;
    },
  });
}

export const sourceControlProviderDescriptors = createProviderDescriptors();

export function publicProviderDescriptor(descriptor: ProviderDescriptor, order: number, extension?: NonNullable<PublicProviderDescriptor['extension']>): PublicProviderDescriptor {
  const { presentation } = descriptor;
  const cli = descriptor.authMethods.cli || undefined;
  const methods = (['device', 'pat', 'cli'] as const).filter((method) => Boolean(descriptor.authMethods[method]));
  const legacyFlow = descriptor.instances?.legacyFlow;
  const published: PublicProviderDescriptor = {
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
    repository: { nestedNamespaces: descriptor.repositoryPath !== 'owner/name' },
    instances: {
      format: descriptor.instance.form,
      defaultInstance: descriptor.instance.defaultInstances[0] ?? null,
      defaultInstances: [...descriptor.instance.defaultInstances],
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
      changeRequestPatch: descriptor.capabilities.changeRequestPatch === true,
    },
  };
  if (presentation.urls.resolve) published.urls.resolve = presentation.urls.resolve;
  if (legacyFlow) published.instances.legacyFlow = { instance: legacyFlow.instance, kind: legacyFlow.kind };
  if (cli?.tool) published.auth.cliName = cli.tool;
  if (cli?.kind === 'service') published.auth.login = { kind: cli.kind, hint: cli.hint };
  if (presentation.token) {
    published.auth.token = { scopes: [...presentation.token.scopes] };
    if (presentation.token.createPath) published.auth.token.createPath = presentation.token.createPath;
  }
  if (descriptor.repositoryPath === 'path') published.repository.pathStyle = 'path';
  const { capabilities } = descriptor;
  if (capabilities.reviewModel !== undefined) published.features.reviewModel = capabilities.reviewModel;
  if (capabilities.revisions !== undefined) published.features.revisions = capabilities.revisions;
  if (capabilities.createVia !== undefined) published.features.createByPush = capabilities.createVia === 'push';
  if (capabilities.discussions !== undefined) {
    published.features.discussions = capabilities.discussions;
    if (presentation.urls.discussion) published.urls.discussion = [...presentation.urls.discussion];
  }
  if (presentation.urls.commit) published.urls.commit = [...presentation.urls.commit];
  if (presentation.urls.user) published.urls.user = [...presentation.urls.user];
  if (extension) {
    published.extension = { guestId: extension.guestId, name: extension.name, version: extension.version };
  }
  return published;
}
