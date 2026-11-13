// Entry point of the installed service: `node main.js --config <service.json>`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseServiceConfig } from './config.js';
import { createIntegrity, resolveIdentity } from './integrity.js';
import { runPreflight } from './preflight.js';
import { createProtectedMcpService } from './service.js';

const log = (event, fields = {}) => process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);

async function main(argv) {
  const index = argv.indexOf('--config');
  if (index === -1 || !argv[index + 1]) {
    process.stderr.write('Usage: main.js --config <service.json>\n');
    return 64;
  }
  const config = parseServiceConfig(JSON.parse(await fs.readFile(argv[index + 1], 'utf8')));
  const engine = await resolveIdentity(config.engineUser);
  const integrityOptions = { owners: [0, process.getuid()], groups: [0], engine };
  const integrity = createIntegrity(integrityOptions);
  const socketDirectory = path.dirname(config.engineSocket);
  if (config.engineSocketGroup !== null) {
    await fs.chown(socketDirectory, -1, config.engineSocketGroup);
    await fs.chmod(socketDirectory, 0o750);
  }
  const adminDirectory = path.dirname(config.adminSocket);
  if (config.adminSocketGroup !== null) await fs.chown(adminDirectory, -1, config.adminSocketGroup);
  await fs.chmod(adminDirectory, 0o750);
  const current = await fs.realpath(path.join(config.installDir, 'current'));
  const service = await createProtectedMcpService({
    version: config.serviceVersion,
    stateDir: config.stateDir,
    engineSocketPath: config.engineSocket,
    subjectsDir: config.subjectsDir,
    engineSocketGroup: config.engineSocketGroup,
    adminSocketPath: config.adminSocket,
    adminSocketGroup: config.adminSocketGroup,
    integrity: integrityOptions,
    workerPath: config.workerPath,
    npmCommand: config.npm,
    enforcement: () => runPreflight({
      integrity,
      engine,
      engineUser: config.engineUser,
      engineUnit: config.engineUnit,
      adminSocket: config.adminSocket,
      trustedPaths: [config.node, ...(config.npm ?? []), ...config.workerPath.split(':'), config.stateDir, config.subjectsDir, socketDirectory, adminDirectory],
      trustedTrees: [current, config.configDir],
      privateDirectories: [config.stateDir, config.subjectsDir],
    }),
    log,
  });
  await service.start();
  await new Promise((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, resolve);
  });
  await service.close();
  return 0;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (error) => {
  log('service_failed', { code: error?.code ?? error?.name ?? 'Error' });
  process.exitCode = 1;
});
