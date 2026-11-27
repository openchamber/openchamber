const ENTERPRISE_CLOUD_HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.ghe\.com$/;

const normalized = (host: string | null | undefined) => String(host ?? '').trim().toLowerCase().replace(/\.$/, '');

const enterpriseCloudSubdomain = (host: string | null | undefined) => ENTERPRISE_CLOUD_HOST.exec(normalized(host))?.[1] ?? null;

export const isGitHubEnterpriseCloudHost = (host: string | null | undefined) => enterpriseCloudSubdomain(host) !== null;

export function gitHubApiBaseUrl(host: string | null | undefined) {
  const instance = normalized(host) || 'github.com';
  if (instance === 'github.com') return 'https://api.github.com';
  if (isGitHubEnterpriseCloudHost(instance)) return `https://api.${instance}`;
  return `https://${instance}/api/v3`;
}

export function gitHubInstanceOfApiHost(hostname: string | null | undefined) {
  const host = normalized(hostname);
  if (host === 'api.github.com') return 'github.com';
  const cloud = host.startsWith('api.') ? host.slice('api.'.length) : '';
  return isGitHubEnterpriseCloudHost(cloud) ? cloud : host;
}

export const isGitHubSshUser = (user: string | null | undefined, host: string | null | undefined) => {
  const name = String(user ?? '').toLowerCase();
  return name === 'git' || (name !== '' && name === enterpriseCloudSubdomain(host));
};

export function repositoryOfApiUrl<Repository extends { owner: string; repo: string }>(repositories: readonly Repository[], url: string, instance: string) {
  const prefix = `${gitHubApiBaseUrl(instance)}/repos/`;
  if (!url.startsWith(prefix)) return null;
  const [owner, repo, ...rest] = url.slice(prefix.length).toLowerCase().split('/');
  return rest.length === 0 ? repositories.find((entry) => entry.owner.toLowerCase() === owner && entry.repo.toLowerCase() === repo) ?? null : null;
}
