import fs from 'node:fs/promises';
import path from 'node:path';
import { readOptional } from './migrate-accounts.js';

const RANGE = 65536;
const FIRST_RANGE = 100000;

const hasRange = (text, name) => text?.split('\n').some((line) => line.startsWith(`${name}:`) && Number(line.split(':')[2]) > 0);

/**
 * A system account gets no subordinate IDs from `useradd`, and rootless Docker needs them: one
 * range after every range either file already holds, the same in both.
 */
async function ensureSubordinateIds({ root = '/', system, account }) {
  const ranges = await readOptional(path.join(root, '/etc/subuid')) ?? '';
  const gids = await readOptional(path.join(root, '/etc/subgid')) ?? '';
  if (hasRange(ranges, account.name) && hasRange(gids, account.name)) return false;
  let end = FIRST_RANGE;
  for (const line of `${ranges}\n${gids}`.split('\n')) {
    const [, start, count] = line.split(':').map(Number);
    if (Number.isSafeInteger(start) && Number.isSafeInteger(count) && start + count > end) end = start + count;
  }
  const start = Math.ceil(end / RANGE) * RANGE;
  const span = `${start}-${start + RANGE - 1}`;
  await system.run('usermod', ['--add-subuids', span, '--add-subgids', span, account.name]);
  return true;
}

/** Rootless Docker for one account, as that account. Never places an account in the host's docker group. */
async function setupRootlessDocker({ root = '/', system, account, say = () => {} }) {
  const unavailable = (reason) => { say(`docker for ${account.name}: unavailable (${reason})`); return { status: 'unavailable', reason }; };
  try {
    const ranges = await readOptional(path.join(root, '/etc/subuid'));
    const gids = await readOptional(path.join(root, '/etc/subgid'));
    if (![ranges, gids].every((text) => hasRange(text, account.name))) return unavailable(`${account.name} has no subordinate IDs`);
    let tool;
    for (const directory of ['/usr/bin', '/usr/local/bin']) {
      const candidate = path.join(directory, 'dockerd-rootless-setuptool.sh');
      if (await fs.access(path.join(root, candidate), fs.constants.X_OK).then(() => true, () => false)) { tool = candidate; break; }
    }
    if (!tool || !await fs.access(path.join(root, '/usr/bin/newuidmap'), fs.constants.X_OK).then(() => true, () => false)) return unavailable('rootless Docker tools are missing');
    await system.run('loginctl', ['enable-linger', account.name]);
    await system.run('runuser', ['-u', account.name, '--', 'env', `HOME=${account.home}`, `XDG_RUNTIME_DIR=/run/user/${account.uid}`, 'PATH=/usr/local/bin:/usr/bin:/bin', tool, 'install']);
    say(`docker for ${account.name}: ready`);
    return { status: 'ready' };
  } catch (error) { return unavailable(error.message); }
}

/** Docker setup is optional. Never place the agent in the host's docker group. */
export const setupAgentDocker = ({ agent, ...rest }) => setupRootlessDocker({ account: agent, ...rest });

/**
 * The front door's own rootless Docker, for the Docker place of isolated spaces: a daemon the agent
 * cannot reach, and no docker group, which would make the front door root-equivalent.
 */
export async function setupFrontDoorDocker({ root = '/', system, front, say = () => {} }) {
  try {
    await ensureSubordinateIds({ root, system, account: front });
  } catch (error) {
    say(`docker for ${front.name}: unavailable (${error.message})`);
    return { status: 'unavailable', reason: error.message };
  }
  return setupRootlessDocker({ root, system, account: front, say });
}
