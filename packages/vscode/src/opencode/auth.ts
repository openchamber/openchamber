import { randomBytes } from 'crypto';

export function generateSecureOpenCodePassword(): string {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function buildOpenCodeAuthHeader(password: string): string {
  const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || 'opencode';
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export function isValidOpenCodePassword(password: string): boolean {
  return typeof password === 'string' && password.trim().length > 0;
}
