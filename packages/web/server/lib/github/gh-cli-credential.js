import { execFileSync } from 'child_process';

function fetchGhCliToken() {
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
      windowsHide: true,
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

export function getGhCliToken() {
  return fetchGhCliToken();
}

