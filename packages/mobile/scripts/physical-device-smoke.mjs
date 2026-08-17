import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BUNDLE_ID = 'com.openchamber.app';
const platform = process.argv[2];
const expectedVersion = process.env.OPENCHAMBER_MOBILE_VERSION;
const expectedBuild = process.env.OPENCHAMBER_MOBILE_BUILD;

function sha256(file) {
  return crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const renderedArgs = options.redactArgs ? '[redacted]' : args.join(' ');
    const renderedStderr = !options.redactArgs && result.stderr ? `: ${result.stderr.trim()}` : '';
    throw new Error(`${command} ${renderedArgs} failed${renderedStderr}`);
  }
  return result.stdout?.trim() ?? '';
}

function requireExactCandidate() {
  if (!expectedVersion || !expectedBuild) throw new Error('OPENCHAMBER_MOBILE_VERSION and OPENCHAMBER_MOBILE_BUILD are required');
  if (!process.env.MOBILE_E2E_CONNECT_URL?.startsWith('openchamber://connect?')) throw new Error('MOBILE_E2E_CONNECT_URL must be a one-time OpenChamber connect URL');
}

export function parseAndroidPhysicalDevices(output) {
  return output.split('\n').slice(1)
    .map((row) => row.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device' && !serial.startsWith('emulator-'));
}

export function parseAndroidPackageInfo(output) {
  return {
    version: output.match(/versionName=([^\s]+)/)?.[1],
    build: output.match(/versionCode=(\d+)/)?.[1],
  };
}

function androidDevice() {
  const rows = parseAndroidPhysicalDevices(run('adb', ['devices'], { capture: true }));
  if (rows.length !== 1) throw new Error(`Expected exactly one physical Android device, found ${rows.length}`);
  return rows[0][0];
}

function androidSmoke() {
  const apk = process.env.OPENCHAMBER_ANDROID_APK;
  if (!apk) throw new Error('OPENCHAMBER_ANDROID_APK is required');
  const serial = androidDevice();
  const signingCertificate = process.env.OPENCHAMBER_ANDROID_SIGNING_CERT_SHA256?.replaceAll(':', '').toLowerCase();
  const signature = run(process.env.OPENCHAMBER_APKSIGNER || 'apksigner', ['verify', '--print-certs', apk], { capture: true, redactArgs: true });
  const actualCertificate = signature.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-f:]+)/i)?.[1]?.replaceAll(':', '').toLowerCase();
  if (!actualCertificate) throw new Error('Android APK signature identity is unavailable');
  if (signingCertificate && actualCertificate !== signingCertificate) throw new Error('Android signing certificate does not match the expected identity');
  run('adb', ['-s', serial, 'install', '-r', apk], { capture: true, redactArgs: true });
  const packageInfo = run('adb', ['-s', serial, 'shell', 'dumpsys', 'package', BUNDLE_ID], { capture: true, redactArgs: true });
  const { version, build } = parseAndroidPackageInfo(packageInfo);
  if (version !== expectedVersion || build !== expectedBuild) throw new Error(`Android candidate mismatch: expected ${expectedVersion} (${expectedBuild}), found ${version} (${build})`);
  run('adb', ['-s', serial, 'shell', 'am', 'force-stop', BUNDLE_ID], { capture: true, redactArgs: true });
  run('adb', ['-s', serial, 'shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', process.env.MOBILE_E2E_CONNECT_URL, BUNDLE_ID], { capture: true, redactArgs: true });
  const pid = run('adb', ['-s', serial, 'shell', 'pidof', BUNDLE_ID], { capture: true, redactArgs: true });
  if (!pid) throw new Error('Android candidate did not remain running');
  return { platform: 'android', distribution: signingCertificate ? 'release-signed-apk' : 'test-apk', version, build, artifactSha256: sha256(apk), signingCertificateSha256: actualCertificate };
}

export function parseIosPhysicalDevices(output) {
  return output.split('== Simulators ==')[0]
    .split('\n')
    .map((line) => line.match(/^(.+?) \([^)]*\) \(([0-9A-Fa-f-]{20,})\)$/))
    .filter(Boolean)
    .map((match) => ({ name: match[1], id: match[2] }))
    .filter((device) => /iPhone|iPad/i.test(device.name));
}

function iosDevice() {
  const physical = parseIosPhysicalDevices(run('xcrun', ['xctrace', 'list', 'devices'], { capture: true }));
  if (physical.length !== 1) throw new Error(`Expected exactly one physical iOS device, found ${physical.length}`);
  return physical[0];
}

export function findInstalledApp(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.bundleIdentifier === BUNDLE_ID || value.bundleID === BUNDLE_ID) return value;
  for (const nested of Object.values(value)) {
    const match = findInstalledApp(nested);
    if (match) return match;
  }
  return null;
}

function iosSmoke() {
  const device = iosDevice();
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'openchamber-ios-device-'));
  const output = path.join(temporary, 'apps.json');
  try {
    run('xcrun', ['devicectl', 'device', 'info', 'apps', '--device', device.id, '--json-output', output], { capture: true, redactArgs: true });
    const app = findInstalledApp(JSON.parse(readFileSync(output, 'utf8')));
    if (!app) throw new Error('OpenChamber is not installed on the physical iOS device');
    const version = String(app.shortVersionString ?? app.version ?? app.CFBundleShortVersionString ?? '');
    const build = String(app.bundleVersion ?? app.buildVersion ?? app.CFBundleVersion ?? '');
    if (version !== expectedVersion || build !== expectedBuild) throw new Error(`iOS TestFlight candidate mismatch: expected ${expectedVersion} (${expectedBuild}), found ${version} (${build})`);
    run('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device.id, '--terminate-existing', '--payload-url', process.env.MOBILE_E2E_CONNECT_URL, BUNDLE_ID], { capture: true, redactArgs: true });
    return { platform: 'ios', distribution: 'testflight', version, build };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requireExactCandidate();
  const result = platform === 'android' ? androidSmoke() : platform === 'ios' ? iosSmoke() : (() => { throw new Error('Usage: physical-device-smoke.mjs <ios|android>'); })();
  console.log(JSON.stringify({ status: 'launched', ...result }));
}
