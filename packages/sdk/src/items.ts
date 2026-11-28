import type { AttachIssueRequest } from './contract.ts';

export type GuestItemRole = 'user' | 'assistant';

export type GuestMessageItem = {
  kind: 'message';
  action: string;
  sessionId: string;
  sessionTitle: string;
  directory: string | null;
  messageId: string;
  role: GuestItemRole;
  text: string;
};

export type GuestSessionItemMessage = {
  id: string;
  role: GuestItemRole;
  text: string;
  createdAt: number;
};

export type GuestSessionItem = {
  kind: 'session';
  action: string;
  sessionId: string;
  sessionTitle: string;
  directory: string | null;
  messages?: GuestSessionItemMessage[];
  truncated?: boolean;
};

export type GuestSelectionItem = {
  kind: 'selection';
  action: string;
  sessionId: string;
  directory: string | null;
  messageId: string;
  text: string;
};

export type GuestFileItem = {
  kind: 'file';
  action: string;
  directory: string | null;
  path: string;
  isDirectory: boolean;
};

export type GuestDiffItem = {
  kind: 'diff';
  action: string;
  directory: string | null;
  path: string;
  startLine: number;
  endLine: number;
  side?: 'additions' | 'deletions';
};

export type GuestLinkItem = {
  kind: 'link';
  identifier: string;
  url?: string;
};

export type GuestItem = AttachIssueRequest | GuestMessageItem | GuestSessionItem | GuestSelectionItem | GuestFileItem | GuestDiffItem | GuestLinkItem;

export type GuestActionItem = GuestMessageItem | GuestSessionItem | GuestSelectionItem | GuestFileItem | GuestDiffItem;

export type ActionResultPayload = { ok: true } | { ok: false; error: string };

export const isGuestMessageItem = (item: GuestItem | null): item is GuestMessageItem => (
  item !== null && item.kind === 'message'
);

export const isGuestSessionItem = (item: GuestItem | null): item is GuestSessionItem => (
  item !== null && item.kind === 'session'
);

export const isGuestLinkItem = (item: GuestItem | null): item is GuestLinkItem => (
  item !== null && item.kind === 'link'
);

export const isGuestAttachItem = (item: GuestItem | null): item is AttachIssueRequest => (
  item !== null && (item.kind === undefined || item.kind === 'issue' || item.kind === 'pull')
);
