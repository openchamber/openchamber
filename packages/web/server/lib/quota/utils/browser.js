import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { getCookies } from '@steipete/sweet-cookie';

const DEFAULT_TIMEOUT_MS = 10_000;

const LINUX_BROWSER_CONFIGS = {
  chromium: {
    dir: '.config/chromium',
    keyringEntry: 'Chromium Safe Storage',
    keyringFolder: 'Chromium Keys',
    passwordEnv: 'SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD',
  },
  'google-chrome': {
    dir: '.config/google-chrome',
    keyringEntry: 'Chrome Safe Storage',
    keyringFolder: 'Chrome Keys',
    passwordEnv: 'SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD',
  },
  'BraveSoftware/Brave-Browser': {
    dir: '.config/BraveSoftware/Brave-Browser',
    keyringEntry: 'Brave Safe Storage',
    keyringFolder: 'Brave Keys',
    passwordEnv: 'SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD',
  },
  'microsoft-edge': {
    dir: '.config/microsoft-edge',
    keyringEntry: 'Microsoft Edge Safe Storage',
    keyringFolder: 'Microsoft Edge Keys',
    passwordEnv: 'SWEET_COOKIE_EDGE_SAFE_STORAGE_PASSWORD',
  },
};

const readKWalletPassword = (entry, folder) => {
  try {
    const result = execFileSync('kwallet-query', ['--read-password', entry, '--folder', folder, 'kdewallet'], { encoding: 'utf8', timeout: 3000 });
    const pw = result.trim();
    return pw && !pw.toLowerCase().startsWith('failed') ? pw : null;
  } catch {
    return null;
  }
};

const readSecretToolPassword = (service, account) => {
  try {
    const result = execFileSync('secret-tool', ['lookup', 'service', service, 'account', account], { encoding: 'utf8', timeout: 3000 });
    return result.trim() || null;
  } catch {
    return null;
  }
};

const resolveProfileDir = (configDir) => {
  const localState = path.join(configDir, 'Local State');
  if (!fs.existsSync(localState)) return null;
  try {
    const ls = JSON.parse(fs.readFileSync(localState, 'utf8'));
    const infoCache = ls?.profile?.info_cache;
    if (infoCache) {
      for (const dir of Object.keys(infoCache)) {
        const profilePath = path.join(configDir, dir);
        if (fs.existsSync(path.join(profilePath, 'Cookies')) || fs.existsSync(path.join(profilePath, 'Network', 'Cookies'))) {
          return profilePath;
        }
      }
    }
  } catch {
  }
  return null;
};

// TODO: upstream to steipete/sweet-cookie
const prepareCookieEnv = () => {
  if (process.platform !== 'linux') return;

  const xdg = process.env.XDG_CURRENT_DESKTOP ?? '';
  const session = process.env.DESKTOP_SESSION ?? '';
  const isKde = xdg.toLowerCase().includes('kde') || session.toLowerCase().includes('kde') || session.toLowerCase().includes('plasma');

  process.env.SWEET_COOKIE_LINUX_KEYRING = isKde ? 'kwallet' : 'gnome';

  if (process.env.SWEET_COOKIE_CHROME_PROFILE) return;

  for (const browser of Object.values(LINUX_BROWSER_CONFIGS)) {
    const configDir = path.join(os.homedir(), browser.dir);
    const localState = path.join(configDir, 'Local State');
    if (!fs.existsSync(localState)) continue;

    const profileDir = resolveProfileDir(configDir);
    if (profileDir) {
      process.env.SWEET_COOKIE_CHROME_PROFILE = profileDir;
    }

    if (!process.env[browser.passwordEnv]) {
      const pw = isKde
        ? readKWalletPassword(browser.keyringEntry, browser.keyringFolder)
        : readSecretToolPassword(browser.keyringEntry, browser.keyringFolder.replace(' Keys', ''));
      if (pw) {
        process.env[browser.passwordEnv] = pw;
      }
    }

    break;
  }
};

export const discoverBrowserCookie = async (hostPattern, cookieName) => {
  const url = hostToUrl(hostPattern);
  if (!url) return null;
  return discoverCookie(url, cookieName);
};

const discoverCookie = async (url, cookieName) => {
  prepareCookieEnv();

  try {
    const { cookies } = await getCookies({
      url,
      names: [cookieName],
      browsers: ['chrome', 'firefox', 'edge'],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    return cookies.length > 0 ? cookies[0].value : null;
  } catch {
    return null;
  }
};

const urlForHost = (host) => {
  const h = typeof host === 'string' ? host.trim() : '';
  if (!h) return null;
  const withProtocol = h.startsWith('http://') || h.startsWith('https://') ? h : `https://${h}`;
  try {
    const u = new URL(withProtocol);
    return u.origin;
  } catch {
    return null;
  }
};

const hostToUrl = (hostPattern) => {
  const src = hostPattern instanceof RegExp ? hostPattern.source : String(hostPattern);
  const cleaned = src.replace(/^\^/, '').replace(/\$$/, '').replace(/\\./g, '.').replace(/^\./, '');
  return urlForHost(cleaned);
};
