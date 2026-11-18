export type WalkthroughSource =
  | { kind: 'working-tree'; scope: 'all' | 'staged' | 'working' }
  | { kind: 'branch'; baseRef: string; headRef: string }
  | { kind: 'commit'; hash: unknown }
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
  linked?: boolean;
}
