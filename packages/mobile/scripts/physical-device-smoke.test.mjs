import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findInstalledApp,
  parseAndroidPackageInfo,
  parseAndroidPhysicalDevices,
  parseIosPhysicalDevices,
} from './physical-device-smoke.mjs';

test('selects only authorized physical Android devices', () => {
  const output = `List of devices attached
R5CX11 device product:panther model:Pixel_7
emulator-5554 device product:sdk model:sdk_gphone64
offline-phone offline
`;
  assert.deepEqual(parseAndroidPhysicalDevices(output), [['R5CX11', 'device', 'product:panther', 'model:Pixel_7']]);
});

test('reads exact Android version identity', () => {
  assert.deepEqual(parseAndroidPackageInfo('versionCode=418 minSdk=24\nversionName=1.18.9\n'), {
    version: '1.18.9',
    build: '418',
  });
});

test('selects physical iOS devices before the simulator section', () => {
  const output = `== Devices ==
Build Mac (macOS 26.0) (00000000-0000-0000-0000-000000000000)
Yulia's iPhone (iOS 26.0) (00008110-0011223344556677)
== Simulators ==
iPhone 17 Pro Simulator (iOS 26.0) (11111111-1111-1111-1111-111111111111)
`;
  assert.deepEqual(parseIosPhysicalDevices(output), [{ name: "Yulia's iPhone", id: '00008110-0011223344556677' }]);
});

test('finds the OpenChamber app in devicectl output without trusting array shape', () => {
  const app = {
    bundleIdentifier: 'com.openchamber.app',
    shortVersionString: '1.18.9',
    bundleVersion: '418',
  };
  assert.equal(findInstalledApp({ result: { devices: [{ apps: [{ bundleIdentifier: 'example.other' }, app] }] } }), app);
});
