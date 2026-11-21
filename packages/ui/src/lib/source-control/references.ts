export interface SourceControlReferenceLink {
  kind: 'issue' | 'pull' | 'discussion';
  number: number;
  title?: string;
  url: string;
  repo?: string;
  createdAt: string | null;
  author?: { login: string; avatarUrl?: string } | null;
  willCloseTarget?: boolean;
}
