import { z } from 'zod';
import {
  OPENCODE_DIAGNOSTICS_RESPONSE_MAX_BYTES,
  readBoundedResponseJson,
  ResponseBodyTooLargeError,
} from './bounded-response-body';

const diagnosticsJsonSummarySchema = z.union([
  z.array(z.json()).transform((value) => ({ kind: 'array' as const, length: value.length })),
  z.record(z.string(), z.json()).transform((value) => {
    const keys = Object.keys(value).slice(0, 8);
    return { kind: 'object' as const, keys, hasMore: Object.keys(value).length > keys.length };
  }),
  z.string().transform(() => ({ kind: 'primitive' as const, valueType: 'string' as const })),
  z.number().transform(() => ({ kind: 'primitive' as const, valueType: 'number' as const })),
  z.boolean().transform(() => ({ kind: 'primitive' as const, valueType: 'boolean' as const })),
  z.null().transform(() => ({ kind: 'primitive' as const, valueType: 'object' as const })),
]);

export const fetchOpenCodeDiagnosticsProbe = async (
  input: string,
  timeoutMs = 6000,
  headers: Record<string, string> = {},
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(input, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    const contentType = response.headers.get('content-type') || '';
    const normalizedContentType = contentType.toLowerCase();
    const isJson = normalizedContentType.includes('json') && !normalizedContentType.includes('text/html');

    let summary = '';
    if (isJson) {
      let jsonSummary: z.infer<typeof diagnosticsJsonSummarySchema>;
      try {
        jsonSummary = await readBoundedResponseJson(response, OPENCODE_DIAGNOSTICS_RESPONSE_MAX_BYTES, diagnosticsJsonSummarySchema);
      } catch (error) {
        if (error instanceof ResponseBodyTooLargeError) throw error;
        jsonSummary = { kind: 'primitive', valueType: 'object' };
      }
      if (jsonSummary.kind === 'array') {
        summary = `json[array] len=${jsonSummary.length}`;
      } else if (jsonSummary.kind === 'object') {
        summary = `json[object] keys=${jsonSummary.keys.join(',')}${jsonSummary.hasMore ? ',…' : ''}`;
      } else {
        summary = `json[${jsonSummary.valueType}]`;
      }
    } else {
      summary = contentType ? `content-type=${contentType}` : 'no content-type';
    }

    return { ok: response.ok && isJson, status: response.status, elapsedMs, summary };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const isAbort =
      controller.signal.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted')));
    const message = isAbort
      ? `timeout after ${timeoutMs}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    return { ok: false, status: 0, elapsedMs, summary: `error=${message}` };
  } finally {
    clearTimeout(timeout);
  }
};
