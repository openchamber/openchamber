
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let devBadge = '';

export const devDockBadgeFromBranch = (branch) => {
  const match = /(?:^|\D)(\d{3,6})(?:\D|$)/.exec(String(branch || ''));
  return match ? match[1] : '';
};

export const selectDockBadge = ({ devNumber, unreadCount }) => (
  devNumber ? { text: devNumber } : { count: unreadCount }
);

export const applyDockBadge = (app, unreadCount) => {
  const badge = selectDockBadge({ devNumber: devBadge, unreadCount });
  if (badge.text) {
    app.dock?.setBadge(badge.text);
    return;
  }
  if (typeof app.setBadgeCount === 'function') {
    app.setBadgeCount(badge.count);
  }
};

const readCurrentBranch = async (cwd) => {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5_000 });
    return stdout.trim();
  } catch {
    return '';
  }
};

export const applyDevDockIdentity = async ({ app, electronDir, log }) => {
  if (process.platform !== 'darwin' || app.isPackaged || !app.dock) return;

  try {
    app.dock.setIcon(path.join(electronDir, 'resources', 'icons', 'dev-icon.png'));

    devBadge = devDockBadgeFromBranch(await readCurrentBranch(electronDir));
    if (devBadge) app.dock.setBadge(devBadge);
    log?.info?.('[electron] dev dock identity applied', { badge: devBadge });
  } catch (error) {
    log?.warn?.('[electron] dev dock identity failed', error);
  }
};
