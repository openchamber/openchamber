import { z } from "zod";
import type { Session } from "@/lib/opencode/model";

const permissionModeSchema = z.enum(["ask", "safety", "auto"]);

export type PermissionMode = z.infer<typeof permissionModeSchema>;

export type PermissionModeMap = Record<string, PermissionMode>;

export const displayedPermissionMode = (mode: PermissionMode, safetyAvailable: boolean): PermissionMode =>
  mode === "safety" && !safetyAvailable ? "ask" : mode;

export const nextPermissionMode = (mode: PermissionMode, safetyAvailable: boolean): PermissionMode => {
  const shown = displayedPermissionMode(mode, safetyAvailable);
  if (shown === "ask") return safetyAvailable ? "safety" : "auto";
  if (shown === "safety") return "auto";
  return "ask";
};

export const permissionModeForNewSession = (
  choice: PermissionMode | undefined,
  inSpace: boolean,
  defaultMode: PermissionMode,
): PermissionMode | undefined => choice ?? (inSpace && defaultMode !== "ask" ? defaultMode : undefined);

export type PermissionPolicySnapshot = {
  modes: PermissionModeMap;
  revision?: number;
};

export const permissionPolicyWireSchema = z.object({
  sessions: z.record(z.string().min(1), z.boolean()),
  modes: z.record(z.string().min(1), permissionModeSchema).optional(),
  revision: z.number().int().nonnegative().optional(),
});

type PermissionPolicyWire = z.infer<typeof permissionPolicyWireSchema>;

export const policySnapshotFromWire = (wire: PermissionPolicyWire): PermissionPolicySnapshot => ({
  modes: wire.modes ?? Object.fromEntries(
    Object.entries(wire.sessions).map(([sessionId, enabled]) => [sessionId, enabled ? "auto" : "ask"] as const),
  ),
  revision: wire.revision,
});

const buildSessionMap = (sessions: Session[]): Map<string, Session> => {
  const map = new Map<string, Session>();
  for (const session of sessions) {
    map.set(session.id, session);
  }
  return map;
};

const resolveLineage = (
  sessionID: string,
  sessions: Session[],
  sessionById?: ReadonlyMap<string, Session>,
): string[] => {
  const map = sessionById ?? buildSessionMap(sessions);
  const result: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = sessionID;

  while (current && !seen.has(current)) {
    seen.add(current);
    result.push(current);
    current = map.get(current)?.parentID;
  }

  return result;
};

export const resolvePermissionMode = (input: {
  modes: PermissionModeMap;
  sessions: Session[];
  sessionById?: ReadonlyMap<string, Session>;
  sessionID: string;
}): PermissionMode => {
  const { modes, sessions, sessionById, sessionID } = input;
  if (Object.keys(modes).length === 0) return "ask";

  for (const id of resolveLineage(sessionID, sessions, sessionById)) {
    const mode = modes[id];
    if (mode) return mode;
  }

  return "ask";
};
