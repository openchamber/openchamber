import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCodexCliLogin, signInEmailOf } from './codex-cli.js';

const tokenWithClaims = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

let codexHome;

beforeEach(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  delete process.env.CODEX_HOME;
  fs.rmSync(codexHome, { recursive: true, force: true });
});

const writeAuth = (contents) => fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(contents));

describe('Codex CLI sign-in', () => {
  it('reads the ChatGPT sign-in from $CODEX_HOME/auth.json', () => {
    writeAuth({ auth_mode: 'chatgpt', tokens: { access_token: 'cli-token', refresh_token: 'cli-refresh', account_id: 'acct_1' } });

    expect(readCodexCliLogin()).toEqual({ accessToken: 'cli-token', accountId: 'acct_1' });
  });

  it('is null when the CLI is signed out or uses an API key', () => {
    expect(readCodexCliLogin()).toBeNull();

    writeAuth({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test', tokens: null });
    expect(readCodexCliLogin()).toBeNull();
  });

  it('reads the file fresh on every call', () => {
    writeAuth({ tokens: { access_token: 'first' } });
    expect(readCodexCliLogin()?.accessToken).toBe('first');

    writeAuth({ tokens: { access_token: 'second' } });
    expect(readCodexCliLogin()?.accessToken).toBe('second');
  });
});

describe('sign-in email of an OpenAI token', () => {
  it('comes from the profile claim', () => {
    expect(signInEmailOf(tokenWithClaims({ 'https://api.openai.com/profile': { email: 'me@example.com' } }))).toBe('me@example.com');
  });

  it('is null for a token without one or that is not a JWT', () => {
    expect(signInEmailOf(tokenWithClaims({ sub: 'user' }))).toBeNull();
    expect(signInEmailOf('opaque-token')).toBeNull();
    expect(signInEmailOf('a.not-base64-json.c')).toBeNull();
  });
});
