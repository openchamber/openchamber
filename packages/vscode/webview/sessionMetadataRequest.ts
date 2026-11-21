export function sessionMetadataRequest(sessionId: string, body: unknown, conditional: boolean) {
  const values = body && typeof body === 'object' && !Array.isArray(body) ? body as { patch?: unknown; expected?: unknown } : {};
  if (conditional && values.expected === undefined) return null;
  return {
    type: conditional ? 'api:sessions/metadata:compare-and-set' : 'api:sessions/metadata:set',
    payload: conditional ? { sessionId, patch: values.patch, expected: values.expected } : { sessionId, patch: values.patch },
  };
}
