import { parentPort, workerData } from 'node:worker_threads';

import { createManagedOpenCodeHandoffV2Store } from './store.js';

parentPort.postMessage({ type: 'ready' });
parentPort.once('message', async (message) => {
  if (message?.type !== 'open') return;
  try {
    const store = createManagedOpenCodeHandoffV2Store({ rootDir: workerData.rootDir });
    await store.close();
    parentPort.postMessage({ type: 'result', ok: true });
  } catch (error) {
    parentPort.postMessage({ type: 'result', ok: false, message: error?.message ?? String(error) });
  }
});
