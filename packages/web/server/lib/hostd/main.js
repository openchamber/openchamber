import fs from 'node:fs/promises';
import path from 'node:path';
import { createDaemon } from './daemon.js';
import { createHostdServer } from './server.js';

if (process.getuid() !== 0) throw new Error('hostd must run as root from the root-owned installed tree');
process.umask(0o077);
const args = process.argv.slice(2);
const socketPath = args.length === 2 && args[0] === '--socket' && path.isAbsolute(args[1]) ? args[1] : null;
if (args.length && socketPath === null) throw new Error('Usage: hostd [--socket <absolute path>]');
const activated = process.env.LISTEN_FDS === '1' && process.env.LISTEN_PID === String(process.pid);
if (!activated && socketPath === null) throw new Error('hostd requires one systemd listening socket');
const host = createHostdServer(await createDaemon());
if (socketPath !== null) {
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o711 });
  host.server.listen(socketPath, async () => { await fs.chmod(socketPath, 0o600); });
} else host.server.listen({ fd: 3 });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void host.close().then(() => process.exit(0)); });
