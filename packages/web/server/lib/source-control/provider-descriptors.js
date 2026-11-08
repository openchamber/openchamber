import { githubDescriptor } from '../github/descriptor.js';
import { gitlabDescriptor } from '../gitlab/descriptor.js';
import { giteaDescriptor } from '../gitea/descriptor.js';
import { gerritDescriptor } from '../gerrit/descriptor.js';
import { forgejoDescriptor } from '../forgejo/descriptor.js';
import {
  EXTENSION_PROVIDER_PREFIX, isExtensionProviderId, isProviderId, isReservedProviderId,
} from './provider-id.js';

/**
 * The built-in source-control providers in priority order: where two could
 * answer the same question (a remote both could own), the earlier one does.
 * Descriptors are static and SDK-free, so the Git layer, bindings and tracked
 * items read them synchronously; implementations load lazily through the
 * provider registry.
 */
// Appended in order of arrival, so the web adapter's fallback for an older
// server (GitHub and GitLab) stays the list's leading entries.
const BUILT_IN_DESCRIPTORS = Object.freeze([githubDescriptor, gitlabDescriptor, giteaDescriptor, gerritDescriptor, forgejoDescriptor]);

/**
 * The hosts the built-ins serve by default (github.com, gitlab.com,
 * codeberg.org). Their
 * credentials are keyed by these hosts, so no extension may serve one.
 */
export const builtInDefaultHosts = Object.freeze(new Set(BUILT_IN_DESCRIPTORS.flatMap((descriptor) => (
  descriptor.instance.defaultInstances.map((instance) => new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(instance) ? instance : `https://${instance}`).hostname)
))));
// Provider routes live at `/api/source-control/<id>/...`, beside the shell's
// own routes, so an id may not be one of those names.
const SHELL_ROUTE_NAMES = Object.freeze(['binding', 'instances', 'providers', 'repository-context']);

const invalidId = (id) => new Error(`Source control provider id is invalid: ${String(id)}`);

/**
 * The optional change-host capabilities must hold values the clients know,
 * and `submit` (merge the way the host's project is set up) is never one
 * choice among others: a host that submits offers nothing else.
 */
function assertChangeCapabilities(descriptor) {
  const { capabilities } = descriptor;
  const invalid = (what) => new Error(`Source control provider ${descriptor.id} has an invalid ${what}`);
  const methods = capabilities.merge ? capabilities.merge.methods : [];
  if (methods.includes('submit') && methods.length !== 1) throw invalid('merge method list: submit must be the only method');
  if (capabilities.reviewModel !== undefined && !['verdict', 'votes'].includes(capabilities.reviewModel)) throw invalid('review model');
  if (capabilities.revisions !== undefined && capabilities.revisions !== true && capabilities.revisions !== false) throw invalid('revisions capability');
  if (capabilities.createVia !== undefined && !['api', 'push'].includes(capabilities.createVia)) throw invalid('create method');
  if (capabilities.discussions !== undefined && capabilities.discussions !== true && capabilities.discussions !== false) throw invalid('discussions capability');
  // Discussions are listed by the reference picker and opened by their address.
  if (capabilities.discussions && (!capabilities.referencePicker || !descriptor.presentation.urls.discussion?.length)) {
    throw invalid('discussions capability: it needs the reference picker and discussion URLs');
  }
}

/**
 * A descriptor facade over a list; the default instance serves the built-ins.
 *
 * Besides the fixed list it holds an extension segment: descriptors of
 * installed extensions' providers (`ext-<guestId>`), attached and detached
 * at runtime as extensions are approved, paused or removed. `list()` is the
 * fixed list in priority order followed by the extensions sorted by id, so
 * a built-in always wins where both could answer; `get` and `has` cover
 * both, so every reader of the facade sees extension providers unchanged.
 */
export function createProviderDescriptors(descriptors = BUILT_IN_DESCRIPTORS) {
  const byId = new Map();
  for (const descriptor of descriptors) {
    if (!isProviderId(descriptor?.id) || isReservedProviderId(descriptor.id) || descriptor.id.startsWith(EXTENSION_PROVIDER_PREFIX)
      || SHELL_ROUTE_NAMES.includes(descriptor.id) || byId.has(descriptor.id)) {
      throw invalidId(descriptor?.id);
    }
    assertChangeCapabilities(descriptor);
    byId.set(descriptor.id, descriptor);
  }
  const fixed = [...byId.values()];
  const extensions = new Map();
  let list = Object.freeze([...fixed]);
  const rebuild = () => {
    const attached = [...extensions.keys()].sort().map((id) => extensions.get(id));
    list = Object.freeze([...fixed, ...attached]);
  };
  return Object.freeze({
    get: (id) => byId.get(id) ?? extensions.get(id) ?? null,
    has: (id) => byId.has(id) || extensions.has(id),
    list: () => list,
    /** Adds an extension provider's descriptor, or replaces the one with its id. */
    attachExtension: (descriptor) => {
      if (!isExtensionProviderId(descriptor?.id)) throw invalidId(descriptor?.id);
      assertChangeCapabilities(descriptor);
      extensions.set(descriptor.id, descriptor);
      rebuild();
    },
    /** True when the id named an attached extension provider. */
    detachExtension: (id) => {
      if (!extensions.delete(id)) return false;
      rebuild();
      return true;
    },
  });
}

export const sourceControlProviderDescriptors = createProviderDescriptors();

/**
 * What a client reads about a provider (`GET /api/source-control/providers`):
 * plain JSON in the shape the UI registry parses, built from the descriptor's
 * own fields plus its `presentation` block. No functions, patterns, transport
 * policy or other server-only fields leave the server. `order` is the
 * registry's priority order. `extension` (`{ guestId, name, version }`) marks
 * a provider an installed extension serves; older clients drop the field.
 * The change-host features (`reviewModel`, `revisions`, `createByPush`, and
 * the presentation's `branchHeads` and `submitRequirements`) and
 * `discussions` (with `urls.discussion`) appear only when the descriptor
 * declares them, and so do `urls.commit` and `urls.user`.
 */
export function publicProviderDescriptor(descriptor, order, extension) {
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
    // A path provider also nests namespaces; older clients read just that.
    repository: { nestedNamespaces: descriptor.repositoryPath !== 'owner/name' },
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
      // Whether the change-request diff (and so the comparison view and
      // walkthroughs) can be read; the list and context are read either way.
      changeRequestPatch: descriptor.capabilities.changeRequestPatch === true,
    },
  };
  // Optional fields are left out, not sent empty, where a provider has none.
  if (legacyFlow) published.instances.legacyFlow = { instance: legacyFlow.instance, kind: legacyFlow.kind };
  if (cli) published.auth.cliName = cli.tool;
  if (presentation.token) {
    published.auth.token = { scopes: [...presentation.token.scopes] };
    if (presentation.token.createPath) published.auth.token.createPath = presentation.token.createPath;
  }
  if (descriptor.repositoryPath === 'path') published.repository.pathStyle = 'path';
  // A change host's capability-derived features, each only when declared, so
  // a provider that declares none publishes exactly what it always did.
  const { capabilities } = descriptor;
  if (capabilities.reviewModel !== undefined) published.features.reviewModel = capabilities.reviewModel;
  if (capabilities.revisions !== undefined) published.features.revisions = capabilities.revisions;
  if (capabilities.createVia !== undefined) published.features.createByPush = capabilities.createVia === 'push';
  if (capabilities.discussions !== undefined) {
    published.features.discussions = capabilities.discussions;
    if (presentation.urls.discussion) published.urls.discussion = [...presentation.urls.discussion];
  }
  // Where a host's commits and people live, for links in item text; left out where it has none.
  if (presentation.urls.commit) published.urls.commit = [...presentation.urls.commit];
  if (presentation.urls.user) published.urls.user = [...presentation.urls.user];
  if (extension) {
    published.extension = { guestId: extension.guestId, name: extension.name, version: extension.version };
  }
  return published;
}
