import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import { normalizePath } from '@/lib/pathNormalization';
import { getMultiRunIdentity } from './identity';

export interface AgentGroupSession {
  id: string;
  groupKey: string;
  path: string;
  providerId: string;
  modelId: string;
  instanceNumber: number;
  branch: string;
  displayLabel: string;
  worktreeMetadata?: WorktreeMetadata;
}

export interface AgentGroup {
  id: string;
  name: string;
  sessions: AgentGroupSession[];
  lastActive: number;
  sessionCount: number;
}

export function buildAgentGroups(sessions: Session[], metaByPath: Map<string, WorktreeMetadata>, projectDirectory: string): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    const sessionPath = normalizePath(session.directory) ?? '';
    const meta = metaByPath.get(sessionPath);
    const identity = getMultiRunIdentity(session, meta?.projectDirectory ?? projectDirectory);
    if (!identity) continue;
    let group = groups.get(identity.key);
    if (!group) {
      group = { id: identity.key, name: identity.groupSlug, sessions: [], lastActive: 0, sessionCount: 0 };
      groups.set(identity.key, group);
    }
    group.sessions.push({
      id: session.id, groupKey: identity.key, path: sessionPath,
      providerId: identity.providerID, modelId: identity.modelID,
      instanceNumber: identity.index ?? 1, branch: meta?.branch ?? '',
      displayLabel: `${identity.providerID}/${identity.modelID}`, worktreeMetadata: meta,
    });
    group.lastActive = Math.max(group.lastActive, session.time.updated ?? session.time.created);
    group.sessionCount += 1;
  }
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => a.providerId.localeCompare(b.providerId)
      || a.modelId.localeCompare(b.modelId) || a.instanceNumber - b.instanceNumber);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || b.lastActive - a.lastActive || a.id.localeCompare(b.id));
}
