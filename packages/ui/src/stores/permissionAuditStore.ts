import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { PermissionRequest, PermissionResponse } from '@/types/permission';
import type { PermissionAuditEntry } from '@/types/permissionAudit';
import { getSafeStorage } from './utils/safeStorage';

type PermissionAuditStore = {
  rowsBySession: Record<string, PermissionAuditEntry[]>;
  setSessionRows: (sessionID: string, rows: PermissionAuditEntry[]) => void;
  recordRequest: (permission: PermissionRequest, options?: { autoApproved?: boolean; directory?: string; timestamp?: number }) => void;
  recordResponse: (sessionID: string, requestID: string, response: PermissionResponse, options?: { autoApproved?: boolean; timestamp?: number }) => void;
};

const MAX_PERMISSION_AUDIT_ROWS_PER_SESSION = 200;

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
};

const normalizeRow = (row: PermissionAuditEntry): PermissionAuditEntry | null => {
  if (!row?.requestID || !row.sessionID) return null;
  return {
    id: typeof row.id === 'string' && row.id.length > 0 ? row.id : `${row.sessionID}:${row.requestID}`,
    sessionID: row.sessionID,
    requestID: row.requestID,
    permission: typeof row.permission === 'string' ? row.permission : '',
    patterns: normalizeStringArray(row.patterns),
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    always: normalizeStringArray(row.always),
    tool: row.tool && typeof row.tool === 'object' ? row.tool : undefined,
    status: row.status === 'approved' || row.status === 'denied' ? row.status : 'requested',
    response: row.response,
    autoApproved: row.autoApproved === true ? true : undefined,
    directory: typeof row.directory === 'string' ? row.directory : undefined,
    requestedAt: typeof row.requestedAt === 'number' ? row.requestedAt : Date.now(),
    respondedAt: typeof row.respondedAt === 'number' ? row.respondedAt : undefined,
  };
};

const sortRows = (rows: PermissionAuditEntry[]): PermissionAuditEntry[] => (
  [...rows].sort((a, b) => a.requestedAt - b.requestedAt || a.requestID.localeCompare(b.requestID))
);

const normalizeRows = (rows: PermissionAuditEntry[]): PermissionAuditEntry[] => {
  const map = new Map<string, PermissionAuditEntry>();
  for (const row of rows) {
    const normalized = normalizeRow(row);
    if (!normalized) continue;
    map.set(normalized.requestID, normalized);
  }
  return sortRows(Array.from(map.values())).slice(-MAX_PERMISSION_AUDIT_ROWS_PER_SESSION);
};

const mergeRows = (existingRows: PermissionAuditEntry[], incomingRows: PermissionAuditEntry[]): PermissionAuditEntry[] => {
  const byRequestId = new Map<string, PermissionAuditEntry>();
  for (const row of normalizeRows(existingRows)) {
    byRequestId.set(row.requestID, row);
  }

  for (const incoming of normalizeRows(incomingRows)) {
    const existing = byRequestId.get(incoming.requestID);
    byRequestId.set(incoming.requestID, {
      ...incoming,
      permission: incoming.permission || existing?.permission || '',
      patterns: incoming.patterns.length > 0 ? incoming.patterns : (existing?.patterns ?? []),
      metadata: Object.keys(incoming.metadata).length > 0 ? incoming.metadata : (existing?.metadata ?? {}),
      always: incoming.always.length > 0 ? incoming.always : (existing?.always ?? []),
      tool: incoming.tool ?? existing?.tool,
      directory: incoming.directory ?? existing?.directory,
      requestedAt: existing?.requestedAt ?? incoming.requestedAt,
    });
  }

  return normalizeRows(Array.from(byRequestId.values()));
};

export const usePermissionAuditStore = create<PermissionAuditStore>()(
  persist(
    (set) => ({
      rowsBySession: {},

      setSessionRows: (sessionID, rows) => {
        if (!sessionID) return;
        set((state) => {
          const existingRows = state.rowsBySession[sessionID] ?? [];
          return {
            rowsBySession: {
              ...state.rowsBySession,
              [sessionID]: mergeRows(existingRows, rows),
            },
          };
        });
      },

      recordRequest: (permission, options) => {
        if (!permission?.sessionID || !permission.id) return;
        const now = options?.timestamp ?? Date.now();
        set((state) => {
          const existingRows = state.rowsBySession[permission.sessionID] ?? [];
          const existing = existingRows.find((row) => row.requestID === permission.id);
          const row: PermissionAuditEntry = {
            ...(existing ?? {}),
            id: existing?.id ?? `${permission.sessionID}:${permission.id}`,
            sessionID: permission.sessionID,
            requestID: permission.id,
            permission: permission.permission,
            patterns: permission.patterns ?? [],
            metadata: permission.metadata ?? {},
            always: permission.always ?? [],
            tool: permission.tool,
            directory: options?.directory ?? existing?.directory,
            requestedAt: existing?.requestedAt ?? now,
            status: options?.autoApproved ? 'approved' : (existing?.status ?? 'requested'),
            response: options?.autoApproved ? 'once' : existing?.response,
            autoApproved: options?.autoApproved === true ? true : existing?.autoApproved,
            respondedAt: options?.autoApproved ? (existing?.respondedAt ?? now) : existing?.respondedAt,
          };
          return {
            rowsBySession: {
              ...state.rowsBySession,
              [permission.sessionID]: normalizeRows([...existingRows.filter((item) => item.requestID !== permission.id), row]),
            },
          };
        });
      },

      recordResponse: (sessionID, requestID, response, options) => {
        if (!sessionID || !requestID) return;
        const now = options?.timestamp ?? Date.now();
        set((state) => {
          const existingRows = state.rowsBySession[sessionID] ?? [];
          const existing = existingRows.find((row) => row.requestID === requestID);
          const row: PermissionAuditEntry = {
            id: existing?.id ?? `${sessionID}:${requestID}`,
            sessionID,
            requestID,
            permission: existing?.permission ?? '',
            patterns: existing?.patterns ?? [],
            metadata: existing?.metadata ?? {},
            always: existing?.always ?? [],
            tool: existing?.tool,
            directory: existing?.directory,
            requestedAt: existing?.requestedAt ?? now,
            status: response === 'reject' ? 'denied' : 'approved',
            response,
            autoApproved: response === 'reject' ? undefined : (options?.autoApproved === true ? true : existing?.autoApproved),
            respondedAt: now,
          };
          return {
            rowsBySession: {
              ...state.rowsBySession,
              [sessionID]: normalizeRows([...existingRows.filter((item) => item.requestID !== requestID), row]),
            },
          };
        });
      },
    }),
    {
      name: 'permission-audit-store',
      storage: createJSONStorage(() => getSafeStorage()),
      partialize: (state) => ({ rowsBySession: state.rowsBySession }),
    },
  ),
);
