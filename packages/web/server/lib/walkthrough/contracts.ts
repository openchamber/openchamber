export interface ReadContext {
  provider: string;
  instance: string;
  accountId: string;
  repositoryId: string;
  bindingRevision: number;
  directory: string;
  primaryRemote: string;
  linked?: true;
}
