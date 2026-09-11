// Standalone runtime worker entry point (plan section 13.3).
//
//   OPENCHAMBER_PLATFORM_DATABASE_URL   required (same platform database)
//   OPENCHAMBER_RUNTIME_DRIVER          fake|docker (default: fake)
//   OPENCHAMBER_RUNTIME_MAX_CONCURRENT  global capacity limit (default: 5)
//   OPENCHAMBER_RUNTIME_WORKER_POLL_MS  poll interval (default: 1000)
//   OPENCHAMBER_RUNTIME_WORKER_RECONCILE_MS  reconcile interval (default: 30000)
//   OPENCHAMBER_RUNTIME_OP_STALE_MS     running-op staleness (default: 600000)
//   OPENCHAMBER_RUNTIME_STARTING_TIMEOUT_MS  starting wedge timeout (default: 600000)
//
// Run: node server/workers/runtime-worker.js
// The docker driver honestly throws "not implemented in this environment -
// pending Linux host"; on the Linux host it becomes the real container
// runtime (plan section 12.1).

import { pathToFileURL } from 'node:url';

import { isPlatformEnabled, createMigratedPlatformDb } from '../lib/platform/index.js';
import { startRuntimeWorker } from '../lib/platform/workspaces/worker.js';
import defaultRuntimeDriver from '../lib/platform/workspaces/runtime-driver.js';

async function main() {
  if (!isPlatformEnabled()) {
    throw new Error(
      'runtime worker requires OPENCHAMBER_PLATFORM_DATABASE_URL to be set',
    );
  }
  const db = await createMigratedPlatformDb();
  const driver = defaultRuntimeDriver();
  console.log(`[runtime-worker] started (driver: ${driver.name ?? 'unknown'})`);

  const worker = startRuntimeWorker({ db, driver, env: process.env, logger: console });
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[runtime-worker] ${signal} received, stopping`);
    await worker.stop();
    await db.end?.();
    process.exit(0);
  };
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  return { db, driver, worker };
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error(`[runtime-worker] fatal: ${error?.message || error}`);
    process.exit(1);
  });
}

export { main };
