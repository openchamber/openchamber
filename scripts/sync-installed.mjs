#!/usr/bin/env node
/**
 * sync-installed.mjs - Sincroniza el fork local de OpenChamber con la app instalada
 * (@openchamberelectron). Previene el drift que causo la lentitud de sesiones:
 * la app instalada corria codigo viejo (asar 14/08) sin los fixes de warmup del
 * fork (commits 15/08) -> boot 3min + proxy storm + UI colgada.
 *
 * Uso:
 *   node scripts/sync-installed.mjs            # sync completo (build + web + asar)
 *   node scripts/sync-installed.mjs --check    # solo verifica drift (rapido, sin tocar)
 *   node scripts/sync-installed.mjs --force    # sync aunque OpenChamber este abierto
 *
 * Requiere: bun (BUN_BIN) y bunx @electron/asar (descarga automatica si falta).
 * Seguridad: aborta si OpenChamber.exe esta corriendo (archivos bloqueados);
 * hace backup timestamped de app.asar + app.asar.unpacked; verifica markers.
 * Tras un auto-update de OpenChamber: ejecutar --check y sync si hay drift.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FORK = process.env.OPENCHAMBER_FORK ?? 'D:/GITHUB/openchamber';
const INSTALLED = process.env.OPENCHAMBER_INSTALLED ??
  'C:/Users/herna/AppData/Local/Programs/@openchamberelectron/resources';
const BUN = process.env.BUN_BIN ?? 'C:/Users/herna/.bun/bin/bun.exe';
const BUNX = process.env.BUNX_BIN ?? 'C:/Users/herna/.bun/bin/bunx.exe';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const force = args.includes('--force');

const fail = (msg) => { console.error('[sync] ERROR: ' + msg); process.exit(1); };
const run = (cmd, cmdArgs, okCodes = [0]) => {
  console.log(`[sync] > ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', windowsHide: true });
  if (!okCodes.includes(r.status)) fail(`${cmd} salio con codigo ${r.status}`);
  return r.status;
};
const openChamberRunning = () => {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq OpenChamber.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
  return /OpenChamber\.exe/i.test(r.stdout || '');
};
const webPkg = () => path.join(INSTALLED, 'app.asar.unpacked', 'node_modules', '@openchamber', 'web');
const markers = () => {
  const lf = path.join(webPkg(), 'server', 'lib', 'opencode', 'lifecycle.js');
  return fs.existsSync(lf) && fs.readFileSync(lf, 'utf8').includes('WARMUP_CONCURRENCY');
};

if (checkOnly) {
  const forkLf = path.join(FORK, 'packages', 'web', 'server', 'lib', 'opencode', 'lifecycle.js');
  const instLf = path.join(webPkg(), 'server', 'lib', 'opencode', 'lifecycle.js');
  const forkProxy = path.join(FORK, 'packages', 'web', 'server', 'lib', 'opencode', 'proxy.js');
  const instProxy = path.join(webPkg(), 'server', 'lib', 'opencode', 'proxy.js');
  const hash = (f) => fs.existsSync(f) ? createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12) : 'MISSING';
  const lfMatch = hash(forkLf) === hash(instLf);
  const proxyMatch = hash(forkProxy) === hash(instProxy);
  const asarOk = fs.existsSync(path.join(INSTALLED, 'app.asar'));
  const warmup = markers();
  console.log('[sync] --check --');
  console.log(`[sync] lifecycle.js fork==instalado : ${lfMatch ? 'OK' : 'DRIFT!'}`);
  console.log(`[sync] proxy.js     fork==instalado : ${proxyMatch ? 'OK' : 'DRIFT!'}`);
  console.log(`[sync] app.asar existe             : ${asarOk ? 'OK' : 'FALTA'}`);
  console.log(`[sync] warmup fix presente         : ${warmup ? 'OK' : 'FALTA'}`);
  console.log(lfMatch && proxyMatch && asarOk && warmup
    ? '[sync] SIN DRIFT - la app instalada esta al dia.'
    : '[sync] DRIFT DETECTADO - ejecuta: node scripts/sync-installed.mjs (con OpenChamber cerrado).');
  process.exitCode = (lfMatch && proxyMatch && asarOk && warmup) ? 0 : 2;
} else {
  if (openChamberRunning() && !force) {
    fail('OpenChamber.exe esta corriendo. Cierralo (bandeja -> Quit) antes de sincronizar, o usa --force.');
  }

  const ts = new Date().toISOString().slice(0, 10);
  const asar = path.join(INSTALLED, 'app.asar');
  const unpacked = path.join(INSTALLED, 'app.asar.unpacked');
  const tmp = path.join(os.tmpdir(), 'openchamber-asar-work');

  run(BUN, ['run', '--cwd', path.join(FORK, 'packages', 'electron'), 'bundle:main']);

  if (fs.existsSync(webPkg())) {
    run('robocopy', [path.join(FORK, 'packages', 'web'), webPkg(),
      '/E', '/XD', 'node_modules', '.git', '/NFL', '/NDL', '/NJH', '/NP', '/R:1', '/W:1'],
      [0, 1, 2, 3, 4, 5, 6, 7]);
  } else {
    fail(`No existe ${webPkg()} - revisa OPENCHAMBER_INSTALLED`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  run(BUNX, ['@electron/asar', 'extract', asar, tmp]);
  fs.copyFileSync(path.join(FORK, 'packages', 'electron', 'dist-bundle', 'main.mjs'),
    path.join(tmp, 'dist-bundle', 'main.mjs'));
  fs.rmSync(asar + '.new', { force: true });
  fs.rmSync(asar + '.new.unpacked', { recursive: true, force: true });
  run(BUNX, ['@electron/asar', 'pack', tmp, asar + '.new', '--unpack', '**/node_modules/**']);

  const bakAsar = asar + `.bak-${ts}`;
  const bakUnpacked = unpacked + `.bak-${ts}`;
  if (!fs.existsSync(bakAsar)) fs.copyFileSync(asar, bakAsar);
  if (!fs.existsSync(bakUnpacked)) fs.cpSync(unpacked, bakUnpacked, { recursive: true });

  fs.rmSync(asar, { force: true });
  fs.renameSync(asar + '.new', asar);
  fs.rmSync(unpacked, { recursive: true, force: true });
  fs.renameSync(asar + '.new.unpacked', unpacked);
  fs.rmSync(tmp, { recursive: true, force: true });

  if (!markers()) fail('marker WARMUP_CONCURRENCY no encontrado tras el sync - revisa el paquete web');
  console.log('[sync] OK - app instalada sincronizada con el fork.');
  console.log(`[sync] Backups: ${bakAsar} / ${bakUnpacked}`);
  console.log('[sync] Reinicia OpenChamber para que tome el codigo nuevo.');
}
