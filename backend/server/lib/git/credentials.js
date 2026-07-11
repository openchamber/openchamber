import fs from 'fs';
import path from 'path';
import os from 'os';

const GIT_CREDENTIALS_PATH = path.join(os.homedir(), '.git-credentials');

export function discoverGitCredentials() {
  const credentials = [];

  if (!fs.existsSync(GIT_CREDENTIALS_PATH)) {
    return credentials;
  }

  try {
    const content = fs.readFileSync(GIT_CREDENTIALS_PATH, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const url = new URL(line.trim());
        const hostname = url.hostname;
        const pathname = url.pathname && url.pathname !== '/' ? url.pathname : '';
        const host = hostname + pathname;
        const username = url.username || '';

        if (host && username) {
          const exists = credentials.some(c => c.host === host && c.username === username);
          if (!exists) {
            credentials.push({ host, username });
          }
        }
      } catch {
        continue;
      }
    }
  } catch (error) {
    console.error('Failed to read .git-credentials:', error);
  }

  return credentials;
}

export function getCredentialForHost(host) {
  if (!fs.existsSync(GIT_CREDENTIALS_PATH)) {
    return null;
  }

  try {
    const content = fs.readFileSync(GIT_CREDENTIALS_PATH, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const url = new URL(line.trim());
        const hostname = url.hostname;
        const pathname = url.pathname && url.pathname !== '/' ? url.pathname : '';
        const credHost = hostname + pathname;

        if (credHost === host) {
          return {
            username: url.username || '',
            token: url.password || ''
          };
        }
      } catch {
        continue;
      }
    }
  } catch (error) {
    console.error('Failed to read .git-credentials for host lookup:', error);
  }

  return null;
}
