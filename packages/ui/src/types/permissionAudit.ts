import type { PermissionResponse } from './permission';

export type PermissionAuditStatus = 'requested' | 'approved' | 'denied';

export interface PermissionAuditEntry {
  id: string;
  sessionID: string;
  requestID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: {
    messageID?: string;
    callID?: string;
  };
  status: PermissionAuditStatus;
  response?: PermissionResponse;
  autoApproved?: boolean;
  directory?: string;
  requestedAt: number;
  respondedAt?: number;
}
