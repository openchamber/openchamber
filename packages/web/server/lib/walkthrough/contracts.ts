export type WalkthroughSource =
  | { kind: 'working-tree'; scope: 'all' | 'staged' | 'working' }
  | { kind: 'branch'; baseRef: string; headRef: string }
  | { kind: 'commit'; hash: string }
  | {
    kind: 'pr';
    number: number;
    sourceRepo?: { owner: string; repo: string };
    revision?: string;
    linked?: true;
  };

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
