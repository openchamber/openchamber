import { describe, expect, it } from 'vitest';
import { createGitRedactor, redactGitText } from './redaction.js';

describe('Git redaction', () => {
  it('removes operation secrets from raw, encoded, protocol, bearer, query, and error text', () => {
    const token = 'tok+/= secret';
    const password = 'password-value';
    const nonce = 'one-operation-nonce';
    const privateKeyPath = '/Users/example/.ssh/private key';
    const redactor = createGitRedactor({ secrets: [token, password, nonce, privateKeyPath] });
    const error = Object.assign(new Error(`failed with ${token}`), {
      stdout: `password=${password}\nnonce=${nonce}`,
      stderr: [
        `Authorization: Bearer ${token}`,
        `https://actor:${password}@example.com/repo.git?access_token=${encodeURIComponent(token)}&safe=yes`,
        encodeURIComponent(privateKeyPath),
      ].join('\n'),
    });

    const safe = redactor.error(error);
    for (const secret of [token, password, nonce, privateKeyPath, encodeURIComponent(token), encodeURIComponent(privateKeyPath)]) {
      expect(safe).not.toContain(secret);
    }
    expect(safe).toContain('[redacted]');
  });

  it('structurally removes URL userinfo and sensitive query values', () => {
    const safe = redactGitText('fatal: https://user:pass@example.com/a.git?private_token=secret&ref=main');
    expect(safe).toContain('https://example.com/a.git?private_token=%5Bredacted%5D&ref=main');
    expect(safe).not.toContain('user');
    expect(safe).not.toContain('pass');
    expect(safe).not.toContain('secret');
  });

  it('bounds every public text field after redaction', () => {
    const redactor = createGitRedactor({ secrets: ['tail-secret'], maxChars: 80 });
    const result = redactor.result({ stdout: `${'x'.repeat(200)}tail-secret`, stderr: '', message: '' });
    expect(result.stdout.length).toBeLessThanOrEqual(80);
    expect(result.stdout).not.toContain('tail-secret');
    expect(result.stdout).toContain('[truncated]');
  });
});
