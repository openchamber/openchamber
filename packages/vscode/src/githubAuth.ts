import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_USER_URL = 'https://api.github.com/user';
const API_EMAILS_URL = 'https://api.github.com/user/emails';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export const DEFAULT_GITHUB_CLIENT_ID = 'Ov23lizomPOC3eFYo56r';
export const DEFAULT_GITHUB_SCOPES = 'repo read:org workflow read:user user:email';

type StoredAuth = {
  accessToken: string;
  scope?: string;
  tokenType?: string;
  createdAt?: number;
  user?: { login: string; id?: number; avatarUrl?: string };
  accountId?: string;
  current?: boolean;
};

type JsonRecord = Record<string, unknown>;

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
};

type TokenResponse = {
  access_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

const authFilePath = (context: vscode.ExtensionContext) =>
  path.join(context.globalStorageUri.fsPath, 'github-auth.json');

const resolveAccountId = (auth: StoredAuth): string => {
  if (typeof auth.accountId === 'string' && auth.accountId.trim()) {
    return auth.accountId.trim();
  }
  if (auth.user?.login) {
    return auth.user.login.trim();
  }
  if (typeof auth.user?.id === 'number') {
    return String(auth.user.id);
  }
  if (auth.accessToken) {
    return `token:${auth.accessToken.slice(0, 8)}`;
  }
  return '';
};

const normalizeAuthList = (list: StoredAuth[]): { list: StoredAuth[]; changed: boolean } => {
  let changed = false;
  let currentFound = false;
  const normalized = list
    .map((entry) => ({
      ...entry,
      accountId: resolveAccountId(entry),
      current: Boolean(entry.current),
    }))
    .filter((entry) => Boolean(entry.accessToken));

  normalized.forEach((entry) => {
    if (entry.current && !currentFound) {
      currentFound = true;
    } else if (entry.current && currentFound) {
      entry.current = false;
      changed = true;
    }
  });

  if (!currentFound && normalized.length > 0) {
    normalized[0].current = true;
    changed = true;
  }

  return { list: normalized, changed };
};

export const readGitHubAuthList = async (context: vscode.ExtensionContext): Promise<StoredAuth[]> => {
  try {
    const raw = await fs.readFile(authFilePath(context), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed) return [];
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const { list: normalized, changed } = normalizeAuthList(list as StoredAuth[]);
    if (changed) {
      await fs.writeFile(authFilePath(context), JSON.stringify(normalized, null, 2), 'utf8');
    }
    return normalized;
  } catch {
    return [];
  }
};

export const readGitHubAuth = async (context: vscode.ExtensionContext): Promise<StoredAuth | null> => {
  const list = await readGitHubAuthList(context);
  if (!list.length) return null;
  return list.find((entry) => entry.current) ?? list[0] ?? null;
};

export const writeGitHubAuth = async (context: vscode.ExtensionContext, auth: StoredAuth): Promise<void> => {
  const list = await readGitHubAuthList(context);
  const next = {
    ...auth,
    accountId: resolveAccountId(auth),
    current: true,
  };
  const index = list.findIndex((entry) => entry.accountId === next.accountId);
  if (index >= 0) {
    list[index] = next;
  } else {
    list.push(next);
  }
  list.forEach((entry) => {
    entry.current = entry.accountId === next.accountId;
  });

  await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
  await fs.writeFile(authFilePath(context), JSON.stringify(list, null, 2), 'utf8');
  try {
    // best-effort perms on unix
    await fs.chmod(authFilePath(context), 0o600);
  } catch {
    // ignore
  }
};

export const activateGitHubAuth = async (context: vscode.ExtensionContext, accountId: string): Promise<boolean> => {
  const list = await readGitHubAuthList(context);
  if (!list.length) return false;
  const id = accountId.trim();
  if (!id) return false;
  let found = false;
  list.forEach((entry) => {
    if (entry.accountId === id) {
      entry.current = true;
      found = true;
    } else {
      entry.current = false;
    }
  });
  if (!found) return false;
  await fs.writeFile(authFilePath(context), JSON.stringify(list, null, 2), 'utf8');
  return true;
};

export const clearGitHubAuth = async (context: vscode.ExtensionContext): Promise<boolean> => {
  try {
    const list = await readGitHubAuthList(context);
    if (!list.length) return true;
    const remaining = list.filter((entry) => !entry.current);
    if (!remaining.length) {
      await fs.rm(authFilePath(context));
      return true;
    }
    remaining[0].current = true;
    await fs.writeFile(authFilePath(context), JSON.stringify(remaining, null, 2), 'utf8');
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') return true;
    return false;
  }
};

const postForm = async <T extends JsonRecord>(url: string, params: Record<string, string>): Promise<T> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'OpenChamber',
    },
    body: new URLSearchParams(params).toString(),
  });
  const payload = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    const errorDescription = typeof payload?.error_description === 'string' ? payload.error_description : '';
    const error = typeof payload?.error === 'string' ? payload.error : '';
    throw new Error(errorDescription || error || response.statusText);
  }
  return payload as T;
};

export const startDeviceFlow = async (clientId: string, scope: string) => {
  const payload = await postForm<DeviceCodeResponse>(DEVICE_CODE_URL, { client_id: clientId, scope });
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    verificationUriComplete: payload.verification_uri_complete,
    expiresIn: payload.expires_in,
    interval: payload.interval,
    scope,
  };
};

export const exchangeDeviceCode = async (clientId: string, deviceCode: string) => {
  const payload = await postForm<TokenResponse>(ACCESS_TOKEN_URL, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: DEVICE_GRANT_TYPE,
  });
  return payload;
};

export const fetchMe = async (accessToken: string) => {
  const response = await fetch(API_USER_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'OpenChamber',
    },
  });
  if (response.status === 401) {
    const error = new Error('unauthorized');
    (error as unknown as { status?: number }).status = 401;
    throw error;
  }
  const payload = (await response.json().catch(() => null)) as JsonRecord | null;
  if (!response.ok || !payload) {
    throw new Error(`GitHub /user failed: ${response.statusText}`);
  }

  const name = typeof payload.name === 'string' ? payload.name : undefined;
  let email = typeof payload.email === 'string' ? payload.email : undefined;
  if (!email) {
    try {
      const emailsResponse = await fetch(API_EMAILS_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'OpenChamber',
        },
      });
      if (emailsResponse.status === 401) {
        const error = new Error('unauthorized');
        (error as unknown as { status?: number }).status = 401;
        throw error;
      }
      const list = (await emailsResponse.json().catch(() => null)) as Array<Record<string, unknown>> | null;
      if (emailsResponse.ok && Array.isArray(list)) {
        const primaryVerified = list.find((e) => Boolean(e?.primary) && Boolean(e?.verified) && typeof e?.email === 'string');
        const anyVerified = list.find((e) => Boolean(e?.verified) && typeof e?.email === 'string');
        email = (primaryVerified?.email as string | undefined) || (anyVerified?.email as string | undefined);
      }
    } catch {
      // ignore
    }
  }

  return {
    login: String(payload.login || ''),
    id: typeof payload.id === 'number' ? payload.id : undefined,
    avatarUrl: typeof payload.avatar_url === 'string' ? payload.avatar_url : undefined,
    name,
    email,
  };
};
