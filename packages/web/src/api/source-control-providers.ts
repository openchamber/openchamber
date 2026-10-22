/**
 * The source-control providers the connected server serves, for the UI's
 * provider registry.
 *
 * A server older than `GET /api/source-control/providers` answers 404; it
 * serves exactly GitHub and GitLab, so this adapter answers with their
 * descriptors instead. They live here, in the web runtime's wire adapter
 * that talks to that server, so `packages/ui` never names a provider. Keep
 * them identical to the server's built-in GitHub and GitLab descriptors.
 */
import { z } from 'zod';
import type { SourceControlIdentity } from '@openchamber/ui/lib/api/types';
import type { RuntimeFetchOptions } from '@openchamber/ui/lib/runtime-fetch';
import {
  sourceControlProviderListSchema,
  type SourceControlProviderDescriptor,
} from '@openchamber/ui/lib/source-control/providers/descriptor';

type ProvidersFetch = (input: string, init?: RuntimeFetchOptions) => Promise<Response>;

const BUILT_IN_FEATURES_OFF: SourceControlProviderDescriptor['features'] = {
  referenceSearch: false, referenceDetail: false, listStatuses: false, referencesAcross: false,
  startThread: false, authorCanReview: false, projectUploads: false, issueCloseReason: false,
  changeRequestTemplates: [], changeRequestPatch: false,
};

export const BUILT_IN_SOURCE_CONTROL_PROVIDERS: readonly SourceControlProviderDescriptor[] = [
  {
    id: 'github',
    label: 'GitHub',
    order: 0,
    terminology: {
      changeRequest: 'pullRequest', changeRequestPrefix: '#', issuePrefix: '#',
      sharedNumberSpace: true, abbreviation: 'PR', promptNoun: 'pull request', ci: 'checks',
    },
    icon: { sprite: 'github', filledSprite: 'github-fill' },
    repository: { nestedNamespaces: false },
    instances: {
      format: 'host', defaultInstance: 'github.com', multiple: true, allowLoopbackHttp: false, allowPort: false,
      reserved: ['github.com'], placeholder: 'https://github.example.com',
      legacyFlow: { instance: 'github.com', kind: 'github-com-device' },
    },
    auth: {
      methods: ['device', 'pat', 'cli'], cliName: 'gh', cliTransport: true,
      token: { scopes: ['repo', 'read:org', 'workflow', 'read:user', 'user:email'], createPath: '/settings/tokens' },
    },
    settings: {
      fields: [
        { id: 'instance', kind: 'instance-url', secret: false },
        { id: 'token', kind: 'personal-access-token', secret: true },
      ],
    },
    urls: { changeRequest: ['/{owner}/{repo}/pull/{number}'], issue: ['/{owner}/{repo}/issues/{number}'] },
    features: {
      ...BUILT_IN_FEATURES_OFF,
      referenceSearch: true, referenceDetail: true, listStatuses: true, referencesAcross: true, issueCloseReason: true,
      changeRequestPatch: true,
    },
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    order: 1,
    terminology: {
      changeRequest: 'mergeRequest', changeRequestPrefix: '!', issuePrefix: '#',
      sharedNumberSpace: false, abbreviation: 'MR', promptNoun: 'merge request', ci: 'pipeline',
    },
    icon: { sprite: 'gitlab' },
    repository: { nestedNamespaces: true },
    instances: {
      format: 'origin', defaultInstance: 'https://gitlab.com', multiple: true, allowLoopbackHttp: true, allowPort: true,
      reserved: [], placeholder: 'https://gitlab.example.com',
    },
    auth: {
      methods: ['device', 'pat', 'cli'], cliName: 'glab', cliTransport: false,
      token: { scopes: ['api'], createPath: '/-/user_settings/personal_access_tokens' },
    },
    settings: {
      fields: [
        { id: 'instance', kind: 'instance-url', secret: false },
        { id: 'token', kind: 'personal-access-token', secret: true },
      ],
    },
    urls: {
      changeRequest: ['/{namespace+}/{repo}/-/merge_requests/{number}'],
      issue: ['/{namespace+}/{repo}/-/issues/{number}', '/{namespace+}/{repo}/-/work_items/{number}'],
    },
    features: {
      ...BUILT_IN_FEATURES_OFF,
      startThread: true, authorCanReview: true, projectUploads: true, changeRequestPatch: true,
      changeRequestTemplates: ['.gitlab/merge_request_templates/Default.md'],
    },
  },
];

/** Where one provider's routes live: every provider read and mutation goes through its own prefix. */
export const providerPath = (identity: SourceControlIdentity, path: string): string => `/api/source-control/${identity.provider}${path}`;

const providersResponseSchema = z.object({ providers: z.array(z.unknown()) });
const errorSchema = z.object({ error: z.string() });

/**
 * The server's providers; GitHub and GitLab on a server that predates the
 * route. Throws on any other failure, and when the server listed providers
 * but none of them could be read: that answer is unreadable, not empty.
 */
export const fetchSourceControlProviders = async (fetch: ProvidersFetch): Promise<SourceControlProviderDescriptor[]> => {
  const response = await fetch('/api/source-control/providers', { headers: { Accept: 'application/json' } });
  if (response.status === 404) return [...BUILT_IN_SOURCE_CONTROL_PROVIDERS];
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorSchema.safeParse(payload);
    throw new Error((failure.success && failure.data.error) || response.statusText || 'Failed to load source control providers');
  }
  const listed = providersResponseSchema.parse(payload).providers;
  const descriptors = sourceControlProviderListSchema.parse(listed);
  if (listed.length > 0 && descriptors.length === 0) {
    throw new Error('Source control providers response contained no readable provider');
  }
  return descriptors;
};
