import { isJsonObject, isNumber, isString } from './guards.js';
import type { JsonValue } from './contracts.js';

const TURN_BOUNDARY_TYPES: ReadonlySet<string> = new Set([
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
]);

export type StaleTurnBoundaryCheck = (payload: JsonValue) => boolean;

export function createTurnBoundaryOrder(): StaleTurnBoundaryCheck {
  const newestBySession = new Map<string, number>();
  return (payload) => {
    if (!isJsonObject(payload) || !isJsonObject(payload.durable) || !isJsonObject(payload.data)) return false;
    const { aggregateID, seq } = payload.durable;
    if (!isString(aggregateID) || !isNumber(seq) || aggregateID !== payload.data.sessionID) return false;
    if (payload.type === 'session.deleted') {
      newestBySession.delete(aggregateID);
      return false;
    }
    const newest = newestBySession.get(aggregateID);
    if (newest === undefined || seq > newest) {
      newestBySession.set(aggregateID, seq);
      return false;
    }
    return isString(payload.type) && TURN_BOUNDARY_TYPES.has(payload.type);
  };
}
