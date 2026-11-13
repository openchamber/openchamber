import path from 'node:path';
import { isPlainObject, isString } from '../../shared/guards.js';

export const PROTOCOL_VERSION = 1;
/** One engine socket frame or MCP message; large tool results fit, a flood does not. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const CONNECTION_ID = /^pmcp_[0-9a-f]{16}$/;
const CONNECTION_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const MAX_FINDINGS = 50;

/** A refusal with a stable code; `status` is the HTTP status an admin socket error frame carries for it. */
export class ProtectedMcpError extends Error {
  constructor(code, { status = 400, message = code } = {}) {
    super(message);
    this.name = 'ProtectedMcpError';
    this.code = code;
    this.status = status;
  }
}

export const isConnectionId = (value) => isString(value) && CONNECTION_ID.test(value);
export const isConnectionName = (value) => isString(value) && CONNECTION_NAME.test(value);

const malformed = { ok: false, code: 'malformed_frame' };

/**
 * The first line a client sends on the engine socket. Only a status request
 * and a hello that names a connection exist; everything else, administrative
 * requests included, is refused before the service does anything.
 */
export function parseEngineFrame(line) {
  if (!isString(line) || Buffer.byteLength(line) > MAX_FRAME_BYTES) return malformed;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return malformed;
  }
  if (!isPlainObject(value) || !isString(value.type)) return malformed;
  const keys = Object.keys(value).sort().join(',');
  if (value.type === 'status') {
    return keys === 'type' ? { ok: true, frame: { type: 'status' } } : malformed;
  }
  if (value.type !== 'hello') return { ok: false, code: 'unsupported_request' };
  if (keys !== 'connection,protocol,type') return malformed;
  if (value.protocol !== PROTOCOL_VERSION) return { ok: false, code: 'protocol_mismatch' };
  if (!isConnectionId(value.connection)) return malformed;
  return { ok: true, frame: { type: 'hello', connection: value.connection } };
}

/** What a destination may say about itself in public: no argument, query, header or environment value. */
function targetSummary(definition) {
  if (definition.transport === 'http') {
    const url = new URL(definition.http.url);
    return { kind: 'url', label: `${url.origin}${url.pathname}` };
  }
  const { command } = definition.stdio;
  if (isString(command)) return { kind: 'command', label: path.basename(command) };
  return { kind: 'package', label: `${command.package}@${command.version}` };
}

const publicFinding = (finding) => {
  const result = { code: finding.code, level: finding.level };
  if (isString(finding.subject)) result.subject = finding.subject;
  return result;
};

/**
 * The status the engine may read. Built field by field from what is meant to
 * be public, so a new definition or credential field never reaches it by accident.
 */
export function toPublicStatus({ version, administration, enforcement, connections }) {
  return {
    protocol: PROTOCOL_VERSION,
    service: { version },
    enforcement: {
      status: enforcement.status,
      checkedAt: enforcement.checkedAt,
      findings: enforcement.findings.slice(0, MAX_FINDINGS).map(publicFinding),
    },
    administration,
    connections: connections.map(({ definition, credential }) => ({
      id: definition.id,
      name: definition.name,
      revision: definition.revision,
      enabled: definition.enabled,
      transport: definition.transport,
      target: targetSummary(definition),
      credential,
    })),
  };
}
