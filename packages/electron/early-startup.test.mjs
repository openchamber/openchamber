import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '' },
  BrowserWindow: class {},
  nativeTheme: {},
  protocol: {},
  screen: {},
}));
const { buildMainWindowOptions, buildRendererAdditionalArguments } = await import('./early-startup.mjs');

const originalPlatform = process.platform;
const originalDataDir = process.env.OPENCHAMBER_DATA_DIR;
const originalTransparency = process.env.OPENCHAMBER_TRANSPARENT_WINDOW;
let dataDir;

const setPlatform = (platform) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

const writeSettings = (settings) => {
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings));
};

const mainWindowOptions = () => buildMainWindowOptions({ bounds: null, backgroundColor: '#000000', additionalArguments: [] });

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-early-startup-'));
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
});

afterEach(() => {
  setPlatform(originalPlatform);
  if (originalTransparency === undefined) delete process.env.OPENCHAMBER_TRANSPARENT_WINDOW;
  else process.env.OPENCHAMBER_TRANSPARENT_WINDOW = originalTransparency;
  fs.rmSync(path.join(dataDir, 'settings.json'), { force: true });
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Electron reads a present `frame: undefined` as false, so every case pins a
// boolean: only `true` gives the window the window manager's title bar.
test('Linux with the system title bar setting asks for the window manager frame', () => {
  setPlatform('linux');
  writeSettings({ desktopLinuxNativeFrame: true });
  const options = mainWindowOptions();
  expect(options.frame).toBe(true);
  expect(options.titleBarStyle).toBe('default');
});

test('Linux without the setting keeps the frameless window with the app title bar', () => {
  setPlatform('linux');
  const options = mainWindowOptions();
  expect(options.frame).toBe(false);
  expect(options.titleBarStyle).toBe('hidden');
});

test('Windows stays frameless even when the Linux setting is saved', () => {
  setPlatform('win32');
  writeSettings({ desktopLinuxNativeFrame: true });
  const options = mainWindowOptions();
  expect(options.frame).toBe(false);
  expect(options.titleBarStyle).toBe('hidden');
});

test('macOS keeps the hidden title bar with its traffic lights', () => {
  setPlatform('darwin');
  writeSettings({ desktopLinuxNativeFrame: true });
  const options = mainWindowOptions();
  expect(options.frame).toBe(false);
  expect(options.titleBarStyle).toBe('hidden');
  expect(options.trafficLightPosition).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
});

test.each([
  ['linux', false, '1', false, true],
  ['linux', true, '1', true, false],
  ['linux', false, undefined, false, false],
  ['linux', false, 'true', false, false],
  ['win32', false, '1', false, false],
  ['darwin', false, '1', false, false],
])('window and renderer agree on native transparency for %s with native frame %s and opt-in %s', (platform, nativeFrame, requested, frame, transparent) => {
  setPlatform(platform);
  writeSettings({ desktopLinuxNativeFrame: nativeFrame });
  if (requested === undefined) delete process.env.OPENCHAMBER_TRANSPARENT_WINDOW;
  else process.env.OPENCHAMBER_TRANSPARENT_WINDOW = requested;
  const options = mainWindowOptions();
  expect(options.frame).toBe(frame);
  expect(options.transparent).toBe(transparent);
  expect(buildRendererAdditionalArguments()).toContain(`--openchamber-native-frame=${frame ? '1' : '0'}`);
  expect(buildRendererAdditionalArguments()).toContain(`--openchamber-transparent-window=${transparent ? '1' : '0'}`);
});
