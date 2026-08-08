import fs from 'node:fs';
import path from 'node:path';

export const PACKAGED_SMOKE_ARG = '--openchamber-packaged-smoke';

export const isPackagedSmokeEnabled = ({ argv, env, packaged }) => (
  packaged === true
  && argv.includes(PACKAGED_SMOKE_ARG)
  && env.OPENCHAMBER_PACKAGED_SMOKE === '1'
  && typeof env.OPENCHAMBER_PACKAGED_SMOKE_DIR === 'string'
  && env.OPENCHAMBER_PACKAGED_SMOKE_DIR.length > 0
);

export const packagedSmokeMarkerPath = (env) => path.join(env.OPENCHAMBER_PACKAGED_SMOKE_DIR, 'ready.json');

export const writePackagedSmokeReady = ({ env, serverReady, rendererReady, workspaceReady = false, requireWorkspace = false }) => {
  if (!serverReady || !rendererReady) return false;
  if (requireWorkspace && !workspaceReady) return false;
  const markerPath = packagedSmokeMarkerPath(env);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(markerPath, JSON.stringify({ serverReady: true, rendererReady: true, ...(requireWorkspace ? { workspaceReady: true, cleanupComplete: true } : {}) }) + '\n', { mode: 0o600 });
  return true;
};
