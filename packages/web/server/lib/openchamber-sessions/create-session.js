import { OPERATOR_CHILD_KIND } from '../session-lineage.js';
import { asNonEmptyString } from '../shared/guards.js';

export const OPERATOR_CHILD_NOTE_SOURCE = 'openchamber-operator-child';

const OPERATOR_CHILD_DENIED_RULES = ['question', 'openchamber_secret'].map((action) => ({ action, resource: '*', effect: 'deny' }));

const OPERATOR_CHILD_NOTE = [
  'The user does not interact with this session. Another agent started it as part of its own work, and your final answer goes to that agent, not to the user.',
  'Nobody answers questions here. When you need a decision, state the question in plain text in your answer and end your turn: do not use tools that wait for an answer, and do not draw openui-lang blocks with buttons or choices.',
].join('\n\n');

export const withoutOperatorChildDenials = (permissions) => (Array.isArray(permissions) ? permissions : []).filter((rule) => !OPERATOR_CHILD_DENIED_RULES.some((denied) => (
  rule?.action === denied.action && rule?.resource === denied.resource && rule?.effect === denied.effect
)));

const operatorChildMetadata = (parentSessionId) => ({ kind: OPERATOR_CHILD_KIND, parentID: parentSessionId });

export const createSession = async ({ client, directory, title, titleByUser = false, startedByExtension = null, operatorParentId = null }) => {
  const input = { location: { directory } };
  const openchamberMetadata = operatorParentId ? operatorChildMetadata(operatorParentId) : {};
  if (title) {
    input.title = title;
    if (titleByUser) openchamberMetadata.workTitle = { title, by: 'user' };
  }
  if (startedByExtension) openchamberMetadata.startedByExtension = startedByExtension;
  if (Object.keys(openchamberMetadata).length > 0) input.metadata = { openchamber: openchamberMetadata };
  if (operatorParentId) input.permissions = OPERATOR_CHILD_DENIED_RULES;
  const session = await client.session.create(input);
  const sessionID = asNonEmptyString(session?.id);
  if (!sessionID) throw new Error('failed to create session');
  if (operatorParentId) await admitOperatorChildNote(client, sessionID, operatorParentId);
  return sessionID;
};

const admitOperatorChildNote = async (client, sessionID, parentSessionId) => {
  try {
    await client.session.synthetic({
      sessionID,
      text: OPERATOR_CHILD_NOTE,
      description: "Part of another session's work",
      metadata: { source: OPERATOR_CHILD_NOTE_SOURCE, parentSessionID: parentSessionId },
      resume: false,
    });
  } catch (error) {
    console.warn(`[OpenChamberSessions] could not tell ${sessionID} that the user does not interact with it:`, error?.message ?? error);
  }
};
