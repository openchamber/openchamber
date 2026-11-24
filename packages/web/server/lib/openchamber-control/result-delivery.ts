import type { SessionInfo } from '@opencode/client';
import { asNonEmptyString } from '../shared/guards.js';
import { isOperatorChildSession, sessionParentId } from '../session-lineage.js';
import type { ControlInput } from './contracts.js';

interface ResultDeliveryDeps {
  dispatchResults: unknown;
}

interface ResultDeliveryContext {
  ownWork: boolean;
  sessionID: string | null;
  parentSessionID: string | null;
  session: SessionInfo | null;
}

const isOwnWorkChild = (session: SessionInfo | null, parentSessionID: string) =>
  Boolean(session) && isOperatorChildSession(session) && sessionParentId(session) === parentSessionID;

export const resolveResultDelivery = (deps: ResultDeliveryDeps, action: string, input: ControlInput, context: ResultDeliveryContext) => {
  if (input.returnResult === true) return true;
  const hasDispatchResults = Boolean(deps.dispatchResults);
  const hasPrompt = Boolean(asNonEmptyString(input.prompt));
  if (context.ownWork && input.returnResult === undefined && input.wait !== true && hasDispatchResults && hasPrompt) return true;
  if (action !== 'session.send' || input.returnResult !== undefined || input.wait === true || !hasDispatchResults || !hasPrompt) return false;
  if (!context.sessionID || !context.parentSessionID) return false;
  return isOwnWorkChild(context.session, context.parentSessionID);
};
