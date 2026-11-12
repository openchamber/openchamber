import { isPlainObject, isString } from '../../shared/guards.js';
import { isConnectionId, ProtectedMcpError } from './contract.js';

const isSubject = (value) => isString(value) && /^(?:agent|space-[0-9a-f]{12})$/.test(value);

export function parseSubject(subject) {
  if (!isSubject(subject)) throw new ProtectedMcpError('invalid_subject');
  return subject;
}

export function parseSubjectConnections(connections) {
  if (!Array.isArray(connections) || !connections.every(isConnectionId)) throw new ProtectedMcpError('invalid_request');
  return [...new Set(connections)].sort();
}

/** Stage 1 snapshots omit subjects. A malformed grant never becomes authority. */
export function parseStoredSubjects(value, definitions) {
  if (value === undefined) return new Map();
  if (!Array.isArray(value)) throw new ProtectedMcpError('state_unreadable');
  const subjects = new Map();
  for (const entry of value) {
    if (!isPlainObject(entry) || !isSubject(entry.subject) || subjects.has(entry.subject)) throw new ProtectedMcpError('state_unreadable');
    const connections = parseSubjectConnections(entry.connections);
    if (connections.some((id) => !definitions.has(id))) throw new ProtectedMcpError('state_unreadable');
    subjects.set(entry.subject, connections);
  }
  return subjects;
}

export const subjectViews = (subjects) => [...subjects].map(([subject, connections]) => ({ subject, connections: [...connections] }));
