import { asNonEmptyString } from '../shared/guards.js';
import { sessionParentId } from '../session-lineage.js';

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
  return Object.fromEntries(Object.entries(session).filter(([, value]) => value !== undefined && value !== null));
};

export const isListedAsChild = (record) => sessionParentId(record) !== null;
