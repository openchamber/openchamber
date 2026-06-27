import { describe, expect, it } from 'vitest';

import { PROVIDER_CREDENTIAL_SCHEMAS } from './schemas.js';

function schema(providerId) {
  const s = PROVIDER_CREDENTIAL_SCHEMAS[providerId];
  if (!s) throw new Error(`No schema for ${providerId}`);
  return s;
}

describe('PROVIDER_CREDENTIAL_SCHEMAS', () => {
  it('exports schemas for all manual-auth providers', () => {
    const expected = [
      'atlascloud',
      'byteplus',
      'longcat',
      'qwencloud',
      'stepfun',
      'mistral',
      'ollama-cloud',
      'opencode-go',
    ];
    for (const id of expected) {
      expect(PROVIDER_CREDENTIAL_SCHEMAS[id]).toBeDefined();
      expect(typeof PROVIDER_CREDENTIAL_SCHEMAS[id].validate).toBe('function');
      expect(typeof PROVIDER_CREDENTIAL_SCHEMAS[id].redact).toBe('function');
      expect(Array.isArray(PROVIDER_CREDENTIAL_SCHEMAS[id].legacyFiles)).toBe(true);
      expect(typeof PROVIDER_CREDENTIAL_SCHEMAS[id].multiAccount).toBe('boolean');
    }
  });

  it('does not expose a credential schema for OAuth providers', () => {
    for (const id of ['xai', 'openai', 'anthropic', 'google', 'zai-coding-plan', 'minimax-coding-plan']) {
      expect(PROVIDER_CREDENTIAL_SCHEMAS[id]).toBe(undefined);
    }
  });

  it('exports schemas for exactly the 8 manual-credential providers (no OAuth providers)', () => {
    const expectedKeys = [
      'atlascloud',
      'byteplus',
      'longcat',
      'mistral',
      'ollama-cloud',
      'opencode-go',
      'qwencloud',
      'stepfun',
    ];
    expect(Object.keys(PROVIDER_CREDENTIAL_SCHEMAS).sort()).toEqual(expectedKeys.sort());
    expect(Object.keys(PROVIDER_CREDENTIAL_SCHEMAS)).toHaveLength(8);
    // xai and poe authenticate via auth.json and must never have a manual schema
    expect(PROVIDER_CREDENTIAL_SCHEMAS.xai).toBe(undefined);
    expect(PROVIDER_CREDENTIAL_SCHEMAS.poe).toBe(undefined);
  });
});

describe('atlascloud schema', () => {
  const s = schema('atlascloud');

  it('validates a cookie with access-token=', () => {
    expect(s.validate({ cookie: 'access-token=eyJtest' })).toEqual({ valid: true });
  });

  it('validates with optional accountUuid', () => {
    expect(
      s.validate({ cookie: 'access-token=x', accountUuid: 'uuid-123' })
    ).toEqual({ valid: true });
  });

  it('rejects missing cookie', () => {
    const result = s.validate({});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cookie');
  });

  it('rejects empty cookie', () => {
    const result = s.validate({ cookie: '' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cookie');
  });

  it('rejects cookie without access-token=', () => {
    const result = s.validate({ cookie: 'session=xyz' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('access-token=');
  });

  it('redacts cookie value', () => {
    const redacted = s.redact({ cookie: 'access-token=secret123; g_state=abc' });
    expect(redacted.cookie).toContain('[REDACTED]');
    expect(redacted.cookie).not.toContain('secret123');
  });

  it('preserves accountUuid in redacted output', () => {
    const redacted = s.redact({
      cookie: 'access-token=x',
      accountUuid: 'uuid-123',
    });
    expect(redacted.accountUuid).toBe('uuid-123');
  });

  it('declares atlas-cookies.json as legacy file', () => {
    expect(s.legacyFiles).toEqual(['atlas-cookies.json']);
  });

  it('is not multiAccount', () => {
    expect(s.multiAccount).toBe(false);
  });
});

describe('byteplus schema', () => {
  const s = schema('byteplus');

  it('validates a cookie with csrfToken', () => {
    expect(s.validate({ cookie: 'csrfToken=abc; session=xyz' })).toEqual({ valid: true });
  });

  it('rejects cookie missing csrfToken', () => {
    const result = s.validate({ cookie: 'session=xyz' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('csrfToken=');
  });

  it('rejects cookie with csrfToken substring but no csrfToken= cookie name', () => {
    const result = s.validate({ cookie: 'notcsrfTokenfoo=bar' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('csrfToken=');
  });

  it('rejects missing cookie', () => {
    const result = s.validate({});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cookie');
  });

  it('redacts cookie value', () => {
    const redacted = s.redact({ cookie: 'csrfToken=secret; session=xyz' });
    expect(redacted.cookie).toContain('[REDACTED]');
    expect(redacted.cookie).not.toContain('secret');
  });

  it('declares byteplus-cookies.json as legacy file', () => {
    expect(s.legacyFiles).toEqual(['byteplus-cookies.json']);
  });
});

describe('longcat schema', () => {
  const s = schema('longcat');

  it('validates with passportToken', () => {
    expect(s.validate({ passportToken: 'token123', region: '2' })).toEqual({ valid: true });
  });

  it('validates with cookie only', () => {
    expect(s.validate({ cookie: 'passport_token_key=token' })).toEqual({ valid: true });
  });

  it('rejects when both passportToken and cookie are missing', () => {
    const result = s.validate({});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('passportToken');
    expect(result.error).toContain('cookie');
  });

  it('rejects cookie missing passport_token_key=', () => {
    const result = s.validate({ cookie: 'session=xyz' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('passport_token_key=');
  });

  it('redacts passportToken and cookie, preserves region', () => {
    const redacted = s.redact({
      passportToken: 'secret-token',
      cookie: 'passport_token_key=secret',
      region: '2',
    });
    expect(redacted.passportToken).not.toContain('secret-token');
    expect(redacted.cookie).toContain('[REDACTED]');
    expect(redacted.region).toBe('2');
  });

  it('declares longcat-cookies.json as legacy file', () => {
    expect(s.legacyFiles).toEqual(['longcat-cookies.json']);
  });
});

describe('qwencloud schema', () => {
  const s = schema('qwencloud');

  it('rejects ticket only (isg is required)', () => {
    const result = s.validate({ ticket: 'ticket123' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('isg');
  });

  it('validates with ticket + isg only (aliyunPk optional, not sent by intl accounts)', () => {
    expect(s.validate({ ticket: 'ticket123', isg: 'isg-value' })).toEqual({ valid: true });
  });

  it('validates with ticket + isg + optional aliyunPk', () => {
    expect(
      s.validate({ ticket: 'ticket123', aliyunPk: 'pk', isg: 'isg-value' })
    ).toEqual({ valid: true });
  });

  it('validates with required plus optional esmTicket', () => {
    expect(
      s.validate({ ticket: 't', aliyunPk: 'pk', isg: 'isg', esmTicket: 'esm' })
    ).toEqual({ valid: true });
  });

  it('rejects missing ticket', () => {
    const result = s.validate({ aliyunPk: 'pk', isg: 'isg' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('ticket');
  });

  it('redacts ticket and esmTicket, preserves aliyunPk', () => {
    const redacted = s.redact({
      ticket: 'secret-ticket',
      aliyunPk: 'pk-123',
      isg: 'isg-value',
      esmTicket: 'esm-secret',
    });
    expect(redacted.ticket).not.toContain('secret-ticket');
    expect(redacted.aliyunPk).toBe('pk-123');
    expect(redacted.isg).toBe('[REDACTED]');
    expect(redacted.esmTicket).not.toContain('esm-secret');
  });

  it('declares qwencloud-cookies.json as legacy file', () => {
    expect(s.legacyFiles).toEqual(['qwencloud-cookies.json']);
  });
});

describe('stepfun schema', () => {
  const s = schema('stepfun');

  it('rejects oasisToken only (oasisWebid is required)', () => {
    const result = s.validate({ oasisToken: 'token123' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('oasisWebid');
  });

  it('validates with both required fields', () => {
    expect(
      s.validate({ oasisToken: 't', oasisWebid: 'webid' })
    ).toEqual({ valid: true });
  });

  it('validates with required plus optional sessionToken', () => {
    expect(
      s.validate({ oasisToken: 't', oasisWebid: 'webid', sessionToken: 'session' })
    ).toEqual({ valid: true });
  });

  it('rejects missing oasisToken', () => {
    const result = s.validate({ oasisWebid: 'webid' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('oasisToken');
  });

  it('redacts oasisToken and sessionToken, preserves oasisWebid', () => {
    const redacted = s.redact({
      oasisToken: 'secret-token',
      oasisWebid: 'webid-123',
      sessionToken: 'session-secret',
    });
    expect(redacted.oasisToken).not.toContain('secret-token');
    expect(redacted.oasisWebid).toBe('webid-123');
    expect(redacted.sessionToken).not.toContain('session-secret');
  });

  it('declares stepfun-cookies.json as legacy file', () => {
    expect(s.legacyFiles).toEqual(['stepfun-cookies.json']);
  });
});

describe('mistral schema', () => {
  const s = schema('mistral');

  it('validates a cookie with csrftoken=', () => {
    expect(s.validate({ cookie: 'csrftoken=abc; other=xyz' })).toEqual({ valid: true });
  });

  it('validates current Mistral csrf_token_<id>= cookie names', () => {
    expect(s.validate({ cookie: 'csrf_token_abc123=token; ory_session_xyz=session' })).toEqual({
      valid: true,
    });
  });

  it('rejects cookie missing csrftoken=', () => {
    const result = s.validate({ cookie: 'other=xyz' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('csrf_token_<id>=');
  });

  it('rejects cookie text that cannot be sent as an HTTP header', () => {
    const result = s.validate({ cookie: 'csrftoken=abc…; ory_session=xyz' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid characters');
  });

  it('rejects missing cookie', () => {
    const result = s.validate({});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cookie');
  });

  it('validates accounts array with valid cookies', () => {
    expect(
      s.validate({
        accounts: [
          { cookie: 'csrftoken=abc; session=xyz' },
          { cookie: 'csrf_token_hash=def; session=uvw' },
        ],
      })
    ).toEqual({ valid: true });
  });

  it('rejects accounts array with invalid cookie', () => {
    const result = s.validate({
      accounts: [{ cookie: 'other=xyz' }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('csrf_token_<id>=');
  });

  it('rejects accounts array with cookie text that cannot be sent as an HTTP header', () => {
    const result = s.validate({
      accounts: [{ cookie: 'csrftoken=abc…; ory_session=xyz' }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid characters');
  });

  it('redacts cookie in single-account form', () => {
    const redacted = s.redact({ cookie: 'csrftoken=secret; other=xyz' });
    expect(redacted.cookie).toContain('[REDACTED]');
    expect(redacted.cookie).not.toContain('secret');
  });

  it('redacts cookies in accounts array', () => {
    const redacted = s.redact({
      accounts: [{ id: 'a', cookie: 'csrftoken=secret' }],
    });
    expect(redacted.accounts[0].cookie).toContain('[REDACTED]');
    expect(redacted.accounts[0].cookie).not.toContain('secret');
  });

  it('declares mistral-cookies.json as legacy file', () => {
    expect(s.legacyFiles).toEqual(['mistral-cookies.json']);
  });

  it('is multiAccount', () => {
    expect(s.multiAccount).toBe(true);
  });
});

describe('ollama-cloud schema', () => {
  const s = schema('ollama-cloud');

  it('validates a cookie with __Secure-session=', () => {
    expect(s.validate({ cookie: '__Secure-session=abc; aid=xyz' })).toEqual({ valid: true });
  });

  it('rejects cookie missing __Secure-session=', () => {
    const result = s.validate({ cookie: 'other=xyz' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('__Secure-session=');
  });

  it('rejects missing cookie', () => {
    const result = s.validate({});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cookie');
  });

  it('redacts cookie value', () => {
    const redacted = s.redact({ cookie: '__Secure-session=secret; aid=xyz' });
    expect(redacted.cookie).toContain('[REDACTED]');
    expect(redacted.cookie).not.toContain('secret');
  });

  it('declares ollama-cookies.json as legacy file', () => {
    expect(s.legacyFiles).toEqual(['ollama-cookies.json']);
  });
});

describe('opencode-go schema', () => {
  const s = schema('opencode-go');

  it('validates single account with workspaceId', () => {
    expect(s.validate({ workspaceId: 'ws-123', authCookie: 'cookie-val' })).toEqual({
      valid: true,
    });
  });

  it('rejects single account without authCookie (both required)', () => {
    const result = s.validate({ workspaceId: 'ws-123' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('authCookie');
  });

  it('validates accounts array', () => {
    expect(
      s.validate({
        accounts: [{ id: 'a', workspaceId: 'ws-1', authCookie: 'c' }],
      })
    ).toEqual({ valid: true });
  });

  it('rejects missing both workspaceId and accounts', () => {
    const result = s.validate({});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('workspaceId');
  });

  it('rejects accounts array with missing workspaceId', () => {
    const result = s.validate({
      accounts: [{ id: 'a', authCookie: 'c' }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('workspaceId');
  });

  it('redacts authCookie in single-account form, preserves workspaceId', () => {
    const redacted = s.redact({
      workspaceId: 'ws-123',
      authCookie: 'secret-cookie',
    });
    expect(redacted.workspaceId).toBe('ws-123');
    expect(redacted.authCookie).not.toContain('secret-cookie');
  });

  it('redacts authCookie in accounts array, preserves workspaceId', () => {
    const redacted = s.redact({
      accounts: [{ id: 'a', workspaceId: 'ws-1', authCookie: 'secret' }],
    });
    expect(redacted.accounts[0].workspaceId).toBe('ws-1');
    expect(redacted.accounts[0].authCookie).not.toContain('secret');
  });

  it('declares opencode-go.json as legacy file', () => {
    expect(s.legacyFiles).toEqual(['opencode-go.json']);
  });

  it('is multiAccount', () => {
    expect(s.multiAccount).toBe(true);
  });

  it('normalizes an authCookie pasted as auth:"<value>" from devtools', () => {
    const out = s.normalize({ workspaceId: 'wrk_1', authCookie: 'auth:"Fe26.2**abc"' });
    expect(out.authCookie).toBe('Fe26.2**abc');
    expect(out.workspaceId).toBe('wrk_1');
  });

  it('normalizes authCookie pasted as auth=<value> and strips surrounding quotes', () => {
    expect(s.normalize({ workspaceId: 'wrk_1', authCookie: 'auth=Fe26.2**abc' }).authCookie).toBe('Fe26.2**abc');
    expect(s.normalize({ workspaceId: 'wrk_1', authCookie: '"Fe26.2**abc"' }).authCookie).toBe('Fe26.2**abc');
    expect(s.normalize({ workspaceId: ' wrk_1 ', authCookie: '  Fe26.2**abc  ' }).workspaceId).toBe('wrk_1');
  });

  it('leaves an already-clean authCookie untouched', () => {
    expect(s.normalize({ workspaceId: 'wrk_1', authCookie: 'Fe26.2**abc' }).authCookie).toBe('Fe26.2**abc');
  });

  it('normalizes authCookie within an accounts array', () => {
    const out = s.normalize({ accounts: [{ id: 'a', workspaceId: 'wrk_1', authCookie: 'auth:"Fe26.2**abc"' }] });
    expect(out.accounts[0].authCookie).toBe('Fe26.2**abc');
  });
});

describe('xai (no manual schema — OAuth provider)', () => {
  it('has no credential schema', () => {
    expect(PROVIDER_CREDENTIAL_SCHEMAS.xai).toBe(undefined);
  });
});
