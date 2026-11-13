import { describe, expect, it } from 'vitest';
import {
  MAX_FRAME_BYTES,
  isConnectionId,
  isConnectionName,
  parseEngineFrame,
  toPublicStatus,
} from './contract.js';

const SENTINEL = 'sentinel-7f3a9c-do-not-leak';
const id = 'pmcp_0123456789abcdef';

describe('engine socket frames', () => {
  it('accepts a status request and a hello naming only a connection id', () => {
    expect(parseEngineFrame('{"type":"status"}')).toEqual({ ok: true, frame: { type: 'status' } });
    expect(parseEngineFrame(JSON.stringify({ type: 'hello', protocol: 1, connection: id })))
      .toEqual({ ok: true, frame: { type: 'hello', connection: id } });
  });

  it.each(['approve', 'create', 'update', 'secret', 'export', 'getCredential', 'propose', 'session', 'oauth'])(
    'refuses the administrative or unknown request %s',
    (type) => {
      expect(parseEngineFrame(JSON.stringify({ type, connection: id, password: SENTINEL })))
        .toEqual({ ok: false, code: 'unsupported_request' });
    },
  );

  it('refuses a hello that tries to choose a destination, command or policy', () => {
    for (const extra of [{ url: 'https://attacker.invalid' }, { command: ['/bin/sh'] }, { env: { TOKEN: 'x' } }, { policy: {} }]) {
      expect(parseEngineFrame(JSON.stringify({ type: 'hello', protocol: 1, connection: id, ...extra })))
        .toEqual({ ok: false, code: 'malformed_frame' });
    }
  });

  it('refuses malformed, oversized and wrong-protocol frames', () => {
    expect(parseEngineFrame('not json')).toEqual({ ok: false, code: 'malformed_frame' });
    expect(parseEngineFrame('[]')).toEqual({ ok: false, code: 'malformed_frame' });
    expect(parseEngineFrame(JSON.stringify({ type: 'hello', protocol: 2, connection: id })))
      .toEqual({ ok: false, code: 'protocol_mismatch' });
    expect(parseEngineFrame(JSON.stringify({ type: 'hello', protocol: 1, connection: 'github' })))
      .toEqual({ ok: false, code: 'malformed_frame' });
    expect(parseEngineFrame(`{"type":"status","pad":"${'x'.repeat(MAX_FRAME_BYTES)}"}`))
      .toEqual({ ok: false, code: 'malformed_frame' });
  });
});

describe('identifiers', () => {
  it('distinguishes connection ids from MCP names', () => {
    expect(isConnectionId(id)).toBe(true);
    expect(isConnectionId('pmcp_0123')).toBe(false);
    expect(isConnectionId('PMCP_0123456789ABCDEF')).toBe(false);
    expect(isConnectionName('github-work')).toBe(true);
    expect(isConnectionName('-github')).toBe(false);
    expect(isConnectionName('a'.repeat(65))).toBe(false);
  });
});

describe('public status', () => {
  it('carries destination summaries and credential states but never values', () => {
    const status = toPublicStatus({
      version: '1.0.0',
      administration: 'shared',
      enforcement: { status: 'unverified', checkedAt: 1, findings: [{ code: 'acl_not_inspected', level: 'error' }] },
      connections: [{
        credential: 'stored',
        definition: {
          id, name: 'gitlab', revision: 3, enabled: true, transport: 'stdio',
          stdio: { command: '/opt/mcp/bin/mcp-gitlab', args: ['--token-literal', SENTINEL], env: { TOKEN: { secret: 'token' }, LITERAL: SENTINEL } },
          policy: { denyTools: ['delete_project'] },
        },
      }, {
        credential: 'authorization_required',
        definition: {
          id: 'pmcp_fedcba9876543210', name: 'sentry', revision: 1, enabled: false, transport: 'http',
          http: { url: `https://mcp.example.com/org/proj?key=${SENTINEL}`, headers: { 'x-api-key': SENTINEL } },
        },
      }],
    });
    expect(JSON.stringify(status)).not.toContain(SENTINEL);
    expect(status.connections).toEqual([
      { id, name: 'gitlab', revision: 3, enabled: true, transport: 'stdio', target: { kind: 'command', label: 'mcp-gitlab' }, credential: 'stored' },
      { id: 'pmcp_fedcba9876543210', name: 'sentry', revision: 1, enabled: false, transport: 'http', target: { kind: 'url', label: 'https://mcp.example.com/org/proj' }, credential: 'authorization_required' },
    ]);
    expect(status.enforcement.status).toBe('unverified');
    expect(status.administration).toBe('shared');
    expect(status).not.toHaveProperty('admin');
  });
});
