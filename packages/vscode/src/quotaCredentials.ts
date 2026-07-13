import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export type ManagedProvider = 'opencode-go' | 'ollama-cloud' | 'cursor';
export type ManagedCredential = Record<string, string>;
const providers = new Set<ManagedProvider>(['opencode-go', 'ollama-cloud', 'cursor']);
const directory = () => path.join(process.env.OPENCHAMBER_DATA_DIR ? path.resolve(process.env.OPENCHAMBER_DATA_DIR) : path.join(os.homedir(), '.config', 'openchamber'), 'quota');
const target = (provider: ManagedProvider) => {
  if (!providers.has(provider)) throw new Error('Unsupported credential provider');
  return path.join(directory(), `${provider}.json`);
};
const clean = (value: unknown) => typeof value === 'string' && !/[\r\n]/.test(value) ? value.trim() : '';

export const normalizeCredential = (provider: ManagedProvider, value: unknown): ManagedCredential | null => {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (provider === 'opencode-go') {
    const workspaceId = clean(data.workspaceId);
    let authCookie = clean(data.authCookie);
    if (authCookie.startsWith('auth=')) authCookie = authCookie.slice(5).trim();
    return workspaceId && authCookie ? { workspaceId, authCookie } : null;
  }
  if (provider === 'ollama-cloud') return clean(data.cookie) ? { cookie: clean(data.cookie) } : null;
  const accessToken = clean(data.accessToken);
  const refreshToken = clean(data.refreshToken);
  return accessToken || refreshToken ? { accessToken, refreshToken } : null;
};

export const readCredential = (provider: ManagedProvider) => {
  try { return normalizeCredential(provider, JSON.parse(fs.readFileSync(target(provider), 'utf8'))); }
  catch (error) { if ((error as { code?: string }).code !== 'ENOENT') console.warn(`Failed to read ${provider} quota credentials`); return null; }
};
export const credentialStatus = (provider: ManagedProvider) => {
  const value = readCredential(provider);
  if (!value) return { configured: false };
  return { configured: true, ...(provider === 'opencode-go' ? { workspaceId: value.workspaceId } : {}), ...(provider === 'cursor' ? { hasRefreshToken: Boolean(value.refreshToken) } : {}), secretMasked: '••••••••' };
};
export const writeCredential = (provider: ManagedProvider, value: ManagedCredential) => {
  const dir = directory(); const file = target(provider); const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  try { fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temp, file); fs.chmodSync(file, 0o600); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return credentialStatus(provider);
};
export const deleteCredential = (provider: ManagedProvider) => { try { fs.unlinkSync(target(provider)); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; } };

export const importCursorCredential = () => {
  const db = path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (process.platform !== 'darwin' || !fs.existsSync(db)) throw new Error('Cursor credential import is unavailable');
  const rows = JSON.parse(execFileSync('sqlite3', ['-json', db, "SELECT key,value FROM ItemTable WHERE key IN ('cursorAuth/accessToken','cursorAuth/refreshToken');"], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) || '[]') as Array<{ key: string; value: string }>;
  const credential = normalizeCredential('cursor', { accessToken: rows.find((row) => row.key.endsWith('accessToken'))?.value, refreshToken: rows.find((row) => row.key.endsWith('refreshToken'))?.value });
  if (!credential) throw new Error('Cursor credentials are unavailable');
  return credential;
};

export const validateCredential = async (provider: ManagedProvider, credential: ManagedCredential) => {
  if (provider === 'ollama-cloud') {
    const response = await fetch('https://ollama.com/settings', { headers: { Cookie: credential.cookie }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    if (response.status === 401 || response.status === 403) throw new Error('Ollama Cloud authentication failed');
    if (!response.ok) throw new Error(`Ollama Cloud returned HTTP ${response.status}`);
    // With redirect: 'follow', an invalid cookie redirects to /signin (200 OK).
    if (response.url && response.url.includes('/signin')) throw new Error('Ollama Cloud authentication failed');
  }
  if (provider === 'cursor') {
    if (!credential.accessToken && credential.refreshToken) {
      const refresh = await fetch('https://api2.cursor.sh/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', client_id: 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB', refresh_token: credential.refreshToken }), signal: AbortSignal.timeout(15_000) });
      const payload = await refresh.json().catch(() => null) as { access_token?: string } | null;
      if (!refresh.ok || !payload?.access_token) throw new Error('Cursor authentication failed');
      credential.accessToken = payload.access_token;
    }
    if (!credential.accessToken) throw new Error('Cursor access token is required');
    const response = await fetch('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', { method: 'POST', headers: { Authorization: `Bearer ${credential.accessToken}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: '{}', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Cursor authentication failed');
  }
};
