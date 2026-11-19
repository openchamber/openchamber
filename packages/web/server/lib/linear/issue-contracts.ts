export interface LinearIssueState {
  id: string | null;
  name: string | null;
  type: string | null;
}

export interface LinearAssignee {
  name: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface LinearIssueTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearRelatedIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: LinearIssueState | null;
  assignee: LinearAssignee | null;
  team: LinearIssueTeam | null;
  priority: number | null;
  updatedAt: string | null;
}

export interface LinearIssueSummary extends LinearRelatedIssue {
  labels: { id: string; name: string; color: string | null }[];
  parent: LinearRelatedIssue | null;
  subIssueProgress: { total: number; done: number; more: boolean } | null;
}

export interface LinearIssue extends LinearIssueSummary {
  description: string | null;
  comments: { id: string; body: string; createdAt: string | null; user: LinearAssignee | null }[];
  subIssues: LinearRelatedIssue[];
  subIssuesMore: boolean;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string | null;
  position: number;
}

export interface LinearIssueLiveSummary {
  identifier: string;
  title: string;
  state: { name: string | null; type: string };
}

export interface LinearIssueRef {
  kind: 'identifier' | 'id';
  value: string;
}

export interface LinearIssueListOptions {
  query?: unknown;
  cursor?: unknown;
  status?: unknown;
  assignee?: unknown;
  teamId?: unknown;
  priority?: unknown;
}

export interface LinearRawIssue {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  url?: unknown;
  state?: unknown;
  assignee?: unknown;
  team?: unknown;
  priority?: unknown;
  updatedAt?: unknown;
  labels?: unknown;
  parent?: unknown;
  children?: unknown;
  comments?: unknown;
  description?: unknown;
  subIssues?: unknown;
}

export interface LinearRawState {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  position?: unknown;
}

export interface LinearRawPerson {
  name?: unknown;
  displayName?: unknown;
  avatarUrl?: unknown;
}

export interface LinearRawTeam {
  id?: unknown;
  key?: unknown;
  name?: unknown;
}

export interface LinearRawLabel {
  id?: unknown;
  name?: unknown;
  color?: unknown;
}

export interface LinearRawComment {
  id?: unknown;
  body?: unknown;
  createdAt?: unknown;
  user?: unknown;
}

export interface LinearRawConnection {
  nodes?: unknown;
  pageInfo?: unknown;
}

export interface LinearIssueFilter {
  state?: {
    type?: { nin?: string[]; eq?: string };
    name?: { neqIgnoreCase?: string; eqIgnoreCase?: string };
    or?: { type?: { eq: string }; name?: { eqIgnoreCase: string } }[];
  };
  assignee?: { isMe: { eq: boolean } };
  creator?: { isMe: { eq: boolean } };
  team?: { id: { eq: string } };
  priority?: { eq: number };
}

export type LinearConnected<Result> = { connected: false } | ({ connected: true } & Result);
