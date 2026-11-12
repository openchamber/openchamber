// Tells development copies of the desktop app apart in the macOS Dock.
//
// An unpackaged run is Electron's own app bundle, so the Dock shows the stock
// Electron icon for every copy. This swaps in the dev icon, the app icon behind
// construction tape, and puts the issue or PR number from the checked-out
// branch on the badge, so copies started from several worktrees can be told
// apart.
//
// The Dock has one badge, and the unread-chats count uses it too. In a dev copy
// whose branch has a number, the number keeps the badge; on a branch without
// one, the unread count works as in the packaged app.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let devBadge = '';

// `fix/4515-browser-scroll-timeout` -> `4515`. Branches without a number get
// no badge.
export const devDockBadgeFromBranch = (branch) => {
  const match = /(?:^|\D)(\d{3,6})(?:\D|$)/.exec(String(branch || ''));
  return match ? match[1] : '';
};

// What the Dock badge shows: the dev number when there is one, otherwise the
// unread-chats count (0 clears the badge).
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
