import fs from 'fs';
import path from 'path';
import os from 'os';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const STORAGE_FILE = path.join(OPENCHAMBER_DATA_DIR, 'jira-auth.json');

export const JIRA_DEPLOYMENT_CLOUD = 'cloud';
export const JIRA_DEPLOYMENT_SERVER = 'server';

const DEPLOYMENTS = new Set([JIRA_DEPLOYMENT_CLOUD, JIRA_DEPLOYMENT_SERVER]);

function ensureStorageDir() {
  if (!fs.existsSync(OPENCHAMBER_DATA_DIR)) {
    fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
  }
}

function writeJsonFile(payload) {
  ensureStorageDir();
  // Atomic write so multiple OpenChamber instances can safely share the file.
  const tmpFile = `${STORAGE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }
  fs.renameSync(tmpFile, STORAGE_FILE);
  try {
    fs.chmodSync(STORAGE_FILE, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * Normalize a user-provided Jira base URL. Returns null when the value is not
 * an http(s) origin — connecting must fail explicitly instead of storing a
 * value later requests cannot use.
 */
export function normalizeJiraBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let candidate = raw.trim();
  const schemeMatch = candidate.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) {
    return null;
  }
  if (!schemeMatch) {
    candidate = `https://${candidate}`;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.hash = '';
  parsed.search = '';
  // Server/Data Center installs commonly live under a context path (e.g.
  // https://jira.corp.example/jira), so the path is preserved.
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeUser(user) {
  if (!user || typeof user !== 'object') return null;
  const normalized = {
    accountId: typeof user.accountId === 'string' ? user.accountId : null,
    displayName: typeof user.displayName === 'string' ? user.displayName : null,
    emailAddress: typeof user.emailAddress === 'string' ? user.emailAddress : null,
    avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : null,
  };
  return normalized.accountId || normalized.displayName || normalized.emailAddress ? normalized : null;
}

function normalizeConnection(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const deployment = DEPLOYMENTS.has(entry.deployment) ? entry.deployment : null;
  const baseUrl = normalizeJiraBaseUrl(entry.baseUrl);
  const apiToken = typeof entry.apiToken === 'string' && entry.apiToken ? entry.apiToken : null;
  const email = typeof entry.email === 'string' && entry.email.trim() ? entry.email.trim() : null;
  if (!deployment || !baseUrl || !apiToken) return null;
  // Jira Cloud REST auth is Basic email:apiToken; a Cloud entry without an
  // email cannot authenticate and must not be treated as connected.
  if (deployment === JIRA_DEPLOYMENT_CLOUD && !email) return null;
  return {
    deployment,
    baseUrl,
    email,
    apiToken,
    user: normalizeUser(entry.user),
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
  };
}

export function getJiraConnection() {
  if (!fs.existsSync(STORAGE_FILE)) return null;
  let raw;
  try {
    raw = fs.readFileSync(STORAGE_FILE, 'utf8');
  } catch (error) {
    console.error('Failed to read Jira auth file:', error);
    return null;
  }
  try {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return normalizeConnection(JSON.parse(trimmed));
  } catch (error) {
    console.error('Failed to parse Jira auth file:', error);
    return null;
  }
}

export function setJiraConnection({ deployment, baseUrl, email, apiToken, user }) {
  const normalized = normalizeConnection({
    deployment,
    baseUrl,
    email,
    apiToken,
    user,
    createdAt: Date.now(),
  });
  if (!normalized) {
    throw new Error('Invalid Jira connection: deployment, baseUrl, and credentials are required');
  }
  writeJsonFile(normalized);
  return normalized;
}

export function clearJiraConnection() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      fs.unlinkSync(STORAGE_FILE);
    }
    return true;
  } catch (error) {
    console.error('Failed to clear Jira auth file:', error);
    return false;
  }
}

export const JIRA_AUTH_FILE = STORAGE_FILE;
