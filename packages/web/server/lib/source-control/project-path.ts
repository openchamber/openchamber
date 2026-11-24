
import type { ProviderDescriptor } from './provider-contract.js';

export const joinProjectPath = (owner: string, name: string) => (owner ? `${owner}/${name}` : name);

export const splitProjectPath = (path: string) => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { owner: '', name: path } : { owner: path.slice(0, slash), name: path.slice(slash + 1) };
};

export const allowsTopLevelProjects = (descriptor: Pick<ProviderDescriptor, 'repositoryPath'> | null | undefined) => descriptor?.repositoryPath === 'path';
