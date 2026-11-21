import { hostOf } from './binding-service.js';
import { redactSensitiveText } from './url-redaction.js';
import { forkRemoteName } from '../git/contributor-remote.js';
import type { BindingRead } from './binding-service-contracts.js';
import type { ProviderDescriptor, ProviderImplementation, ProviderReadContext } from './provider-contract.js';

type ProviderIdentity = Pick<ProviderReadContext, 'provider' | 'instance'>;
type RemoteEndpoint = { host: string; port?: number; sshPort?: number };
type HostOwner = { provider: string; owns(endpoint: RemoteEndpoint): string | null };
export type ChangeRequestHead = Awaited<ReturnType<NonNullable<ProviderImplementation['resources']['readChangeRequestHead']>>>;
export interface ChangeRequestWorktreeOptions {
  readBinding(directory: string): Promise<BindingRead>;
  providers: {
    list(): readonly ProviderDescriptor[];
    implementation(id: string): Promise<{ auth: Pick<ProviderImplementation['auth'], 'ownsHost' | 'listInstances' | 'listSshHosts'> } | null>;
  };
  readCurrentAccountId(identity: ProviderIdentity): Promise<string | null>;
  readChangeRequestHead(input: { context: ProviderReadContext; number: number }): Promise<ChangeRequestHead>;
}
const hasErrorMessage = (value: unknown): value is { message?: unknown } => value !== null && value !== undefined;

const remoteEndpoint = (displayUrl: string): RemoteEndpoint | null => {
  const host = hostOf(displayUrl);
  if (!host) return null;
  const text = String(displayUrl).trim();
  if (/^https?:\/\//i.test(text) && URL.canParse(text)) {
    const url = new URL(text);
    return { host, port: Number(url.port || (url.protocol === 'http:' ? 80 : 443)) };
  }
  if (/^ssh:\/\//i.test(text) && URL.canParse(text)) {
    const url = new URL(text);
    return { host, sshPort: Number(url.port || 22) };
  }
  if (!text.includes('://') && /^(?:[^@/:\s]+@)?[^/:\s]+:[^\s]+$/.test(text)) return { host, sshPort: 22 };
  return { host };
};

const sourceControlError = (message: string, status: number, code: string) => Object.assign(new Error(message), { status, code });

export const createChangeRequestWorktreeSource = ({
  readBinding,
  providers,
  readCurrentAccountId,
  readChangeRequestHead,
}: ChangeRequestWorktreeOptions) => {
  const hostOwners = async () => {
    const owners: HostOwner[] = [];
    for (const descriptor of providers.list()) {
      try {
        const impl = await providers.implementation(descriptor.id);
        if (!(impl?.auth?.ownsHost instanceof Function)) continue;
        const knownInstances = [...descriptor.instance.defaultInstances, ...(await impl.auth.listInstances?.()) ?? []];
        const knownSshHosts = (await impl.auth.listSshHosts?.()) ?? [];
        owners.push({ provider: descriptor.id, owns: (endpoint) => impl.auth.ownsHost({ ...endpoint, knownInstances, knownSshHosts }) });
      } catch (error) {
        console.warn(`Skipping ${descriptor.label} for a change request worktree:`, redactSensitiveText(hasErrorMessage(error) ? error.message : undefined));
      }
    }
    return owners;
  };
  const identityForEndpoint = (endpoint: RemoteEndpoint | null, owners: HostOwner[]) => {
    if (!endpoint) return null;
    for (const owner of owners) {
      const instance = owner.owns(endpoint);
      if (instance) return { provider: owner.provider, instance };
    }
    return null;
  };
  const identityKey = (identity: ProviderIdentity) => `${identity.provider}:${identity.instance}`;

  const readContexts = async (directory: string) => {
    const read = await readBinding(directory);
    const contextFor = (identity: ProviderIdentity, accountId: string, primaryRemote: string): ProviderReadContext => ({
      directory,
      repositoryId: read.repository.repositoryId,
      provider: identity.provider,
      instance: identity.instance,
      accountId,
      bindingRevision: read.revision,
      primaryRemote,
    });
    const providers = read.binding?.providers ?? [];
    const contexts = providers
      .filter((provider) => provider.readiness === 'ready'
        && provider.endpoint?.fingerprint === read.repository.remotes.find((remote) => remote.name === provider.primaryRemote)?.fetch.fingerprint)
      .map((provider) => contextFor(provider, provider.accountId, provider.primaryRemote));
    const covered = new Set(providers.filter((provider) => provider.readiness !== 'account-unavailable').map(identityKey));
    const owners = await hostOwners();
    const remotes = [...read.repository.remotes].sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0));
    for (const remote of remotes) {
      const identity = identityForEndpoint(remoteEndpoint(remote.push.displayUrl) ?? remoteEndpoint(remote.fetch.displayUrl), owners);
      if (!identity || covered.has(identityKey(identity))) continue;
      const accountId = await readCurrentAccountId(identity);
      if (!accountId) continue;
      covered.add(identityKey(identity));
      contexts.push(contextFor(identity, accountId, remote.name));
    }
    return contexts;
  };

  return async ({ directory, number }: { directory: string; number: number }) => {
    const contexts = await readContexts(directory);
    const order = providers.list();
    const context = order.map((descriptor) => contexts.find((candidate) => candidate.provider === descriptor.id)).find(Boolean);
    if (!context) {
      const labels = order.map((descriptor) => descriptor.label);
      const named = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}` : labels.join('');
      throw sourceControlError(`No connected ${named} account can read this project`, 409, 'AUTHENTICATION_REQUIRED');
    }
    const head = await readChangeRequestHead({ context, number });
    return {
      headBranch: head.headBranch,
      sourceRequest: {
        context,
        project: head.project,
        number,
        expectedHeadSha: head.headSha,
        requestedRemoteName: forkRemoteName(head.headOwner),
      },
    };
  };
};
