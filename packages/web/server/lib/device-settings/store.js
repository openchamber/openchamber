import { createRequire } from 'node:module';
import { isBoolean, isPlainObject, isString } from '../shared/guards.js';

/**
 * The device settings each open OpenChamber window reports: the settings the
 * registry scopes to one device (sidebar width, message limit, theme choice,
 * panel layout...), which live only in that window's own storage and never
 * reach `settings.json`. The agent tool reads them here (`settings.devices`);
 * nothing writes them back.
 *
 * Kept in memory only: a window reports again after a change and on load, so
 * a restart forgets devices until their windows report again. At most
 * `maxDevices` devices are kept, the least recently reported dropped first.
 * Only the reportable keys are kept, so a modified client cannot carry
 * anything else in: the registry's device-scoped preferences, without the
 * transient state the UI leaves out (per-folder panels, open dialogs, the
 * Settings page on screen, "last viewed" stamps, terminal names). Keep this
 * list equal to `readDeviceSettings` in
 * `packages/ui/src/lib/settings/deviceSettingsReport.ts`.
 */
// Identifier-like strings only (surface and section ids), so a report cannot
// carry free text the agent would then read as a setting.
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;
const isIdentifier = (value) => isString(value) && IDENTIFIER.test(value);
// Whole numbers within the range the UI keeps the setting in.
const integer = (min, max) => (value) => Number.isInteger(value) && value >= min && value <= max;
const pixels = integer(0, 10_000);
const oneOf = (...allowed) => (value) => allowed.includes(value);
const identifierList = (value) => Array.isArray(value) && value.length <= 64 && value.every(isIdentifier);
const identifierMap = (isValue) => (value) => isPlainObject(value)
  && Object.keys(value).length <= 64
  && Object.entries(value).every(([key, entry]) => isIdentifier(key) && isValue(entry));

// The value check for each reportable key; a key absent here is not kept.
const REPORTABLE = {
  isSidebarOpen: isBoolean,
  sidebarWidth: pixels,
  contextRailOrder: identifierList,
  contextRailHiddenSurfaces: identifierList,
  mobileWorkspaceTabOrder: identifierList,
  mobileWorkspaceHiddenTabs: identifierList,
  contextSurfaceZones: identifierMap(isIdentifier),
  contextEditorTreeVisible: isBoolean,
  contextEditorVisible: isBoolean,
  contextEditorTreeWidth: pixels,
  workStatusExpandedSections: identifierMap(isBoolean),
  messageQueueExpanded: isBoolean,
  messageLimit: integer(10, 500),
  walkthroughTocWidth: pixels,
  diffFileListMode: oneOf('flat', 'tree'),
  diffFileTreeWidth: pixels,
  showTerminalQuickKeysOnDesktop: isBoolean,
  dockBadgeEnabled: isBoolean,
  alwaysShowScrollbars: isBoolean,
  mobileKeyboardMode: oneOf('native', 'resize-content'),
  desktopWindowControlsPosition: oneOf('left', 'right'),
  desktopWindowControlsStyle: oneOf('classic', 'traffic-lights'),
  inputBarOffset: integer(0, 2_000),
};
const REPORTABLE_KEYS = new Set(Object.keys(REPORTABLE));
// Every reportable key must stay device-scoped in the registry.
const registry = createRequire(import.meta.url)('../opencode/settings-registry.json');
const DEVICE_KEYS = new Set([...REPORTABLE_KEYS].filter((key) => registry.fields[key]?.scope === 'device'));
const SURFACES = new Set(['web', 'desktop', 'vscode', 'mobile']);
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_REPORT_BYTES = 64 * 1024;

export const createDeviceSettingsStore = ({ now = Date.now, maxDevices = 20 } = {}) => {
  const devices = new Map();

  /** @returns {{ ok: true } | { ok: false, status: number, error: string }} */
  const report = (input) => {
    if (!isPlainObject(input)) return { ok: false, status: 400, error: 'A report is an object' };
    const { deviceId, surface, values, revision } = input;
    if (!isString(deviceId) || !DEVICE_ID_PATTERN.test(deviceId)) return { ok: false, status: 400, error: 'deviceId is 8 to 64 letters, digits, - or _' };
    if (!SURFACES.has(surface)) return { ok: false, status: 400, error: `surface is one of ${[...SURFACES].join(', ')}` };
    if (!isPlainObject(values)) return { ok: false, status: 400, error: 'values is an object of device settings' };
    if (JSON.stringify(values).length > MAX_REPORT_BYTES) return { ok: false, status: 413, error: 'Device settings report is too large' };
    if (revision !== undefined && !Number.isFinite(revision)) return { ok: false, status: 400, error: 'revision is a number' };
    // A report older than the one held arrived late (a closing window's send
    // can overtake one in flight); the newer one stays.
    const held = devices.get(deviceId);
    if (held && Number.isFinite(revision) && Number.isFinite(held.revision) && revision <= held.revision) return { ok: true };
    // A key the registry limits to other surfaces (the mobile keyboard on a
    // desktop window) is a default this window never uses.
    const usedHere = (key) => !registry.fields[key].surfaces || registry.fields[key].surfaces.includes(surface);
    const kept = Object.fromEntries(Object.entries(values).filter(([key, value]) => DEVICE_KEYS.has(key) && usedHere(key) && REPORTABLE[key](value)));
    devices.delete(deviceId);
    devices.set(deviceId, { deviceId, surface, values: kept, updatedAt: now(), revision });
    while (devices.size > maxDevices) devices.delete(devices.keys().next().value);
    return { ok: true };
  };

  /** Every reported device, most recently reported first. */
  const list = () => [...devices.values()].reverse().map(({ revision: _revision, ...device }) => structuredClone(device));

  return { report, list };
};
