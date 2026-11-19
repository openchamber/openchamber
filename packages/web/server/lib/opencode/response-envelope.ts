import { isRecord } from '../shared/object-guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

const isJsonEnvelope = (body: JsonValue | undefined): body is JsonObject => isRecord(body);

export function unwrapOpenCodeResponse(body: JsonValue | undefined) {
  if (!isJsonEnvelope(body)) return body;
  return 'data' in body && !('cursor' in body) ? body.data : body;
}
