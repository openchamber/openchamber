import { asNonEmptyString } from '../shared/guards.js';
import { sessionParentId } from '../session-lineage.js';

/**
 * What `session.list` tells about one session. The OpenCode record runs to
 * about 750 characters (tokens, cost, permissions, every metadata
 * namespace), a session in work to about 1,700; this keeps what choosing a
 * session needs, about 210. `session.status` and `session.messages` read
 * one session in full. `workMembership` is null while In work is off.
 */
export const listedSession = (record, workMembership) => {
  const session = {
    id: record.id,
    title: asNonEmptyString(record.title),
    directory: asNonEmptyString(record.location?.directory) ?? asNonEmptyString(record.directory),
    updated: record.time?.updated,
    archived: record.time?.archived,
    parentID: sessionParentId(record),
    agent: asNonEmptyString(record.agent),
    model: record.model,
    outcome: record.outcome,
  };
  if (workMembership) {
    session.inWork = workMembership.isInWork(record);
    session.doneSuggested = workMembership.isDoneSuggested(record);
  }
  // A field the record lacks stays out of the answer.
  return Object.fromEntries(Object.entries(session).filter(([, value]) => value !== undefined && value !== null));
};

export const isListedAsChild = (record) => sessionParentId(record) !== null;
