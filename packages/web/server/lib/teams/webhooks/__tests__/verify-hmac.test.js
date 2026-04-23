import { describe, it, expect } from 'vitest';
import { verifyGitHubSignature } from '../verify-hmac.js';
import crypto from 'crypto';

describe('verifyGitHubSignature', () => {
  const secret = 'my-super-secret';
  const payload = '{"action": "opened"}';
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const validSignature = `sha256=${hmac}`;

  it('returns true for valid signature', () => {
    expect(verifyGitHubSignature(payload, validSignature, secret)).toBe(true);
  });

  it('returns false for invalid signature', () => {
    expect(verifyGitHubSignature(payload, 'sha256=invalid123', secret)).toBe(false);
  });

  it('returns false if prefix is missing', () => {
    expect(verifyGitHubSignature(payload, hmac, secret)).toBe(false);
  });

  it('returns false if missing signature or secret', () => {
    expect(verifyGitHubSignature(payload, undefined, secret)).toBe(false);
    expect(verifyGitHubSignature(payload, validSignature, undefined)).toBe(false);
  });

  it('returns false for mismatched payload', () => {
    const wrongPayload = '{"action": "closed"}';
    expect(verifyGitHubSignature(wrongPayload, validSignature, secret)).toBe(false);
  });
});
