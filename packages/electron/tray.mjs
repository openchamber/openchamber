// Native tray/menu bar controller.
//
// Surfaces a glanceable, always-visible view of OpenChamber's live state:
//  1. an aggregate activity indicator (idle / busy / error+retry) in the icon
//     title, rendered as a monochrome template image plus a text counter so it
//     adapts to light/dark menu bars (colour can't be shown in template mode);
//  2. pending approvals (permission + question requests) that block agents,
//     with inline Allow/Deny actions;
//  3. the list of active sessions with status + branch, click to focus;
//  4. quick actions (new session, show window, quit).
//
// The live state lives in the renderer (Zustand). It is pushed here over the
// existing IPC bridge via the `desktop_tray_update` command; this module owns
// only presentation. Tray clicks call back through `onAction`, which main.mjs
// routes to the renderer (focus-session, respond-permission, …) or handles
// natively (show-main-window, quit).
//
// The menu/tooltip text and structure are built by tray-menu.mjs (pure, testable
// and locale-aware); this file only turns that description into a native Tray +
// Menu and manages the icon animation.

import { Tray, Menu, nativeImage } from 'electron';
import { normalizeTrayLocale } from './tray-locales.mjs';
import {
  buildTrayMenu,
  computeTrayIconState,
  computeTrayTitle,
  computeTrayTooltip,
  trayCounts,
  trayMenuKey,
} from './tray-menu.mjs';

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
// Linux StatusNotifier hosts often blank or drop oversized tray images; keep
// the icon at a panel-typical size so AppImage trays stay visible.
const LINUX_TRAY_ICON_PX = 22;

// Frame cadence for the "breathing" busy animation. With the eased frame set
// (denser near the extremes) a slower tick reads as a calm, continuous glow
// rather than a snappy blink.
const ANIM_INTERVAL_MS = 75;

const toTemplateImage = (p) => {
  let image = nativeImage.createFromPath(p);
  if (image.isEmpty()) return image;
  if (isMac) image.setTemplateImage(true);
  if (isLinux) {
    const { width, height } = image.getSize();
    if (width > LINUX_TRAY_ICON_PX || height > LINUX_TRAY_ICON_PX) {
      image = image.resize({
        width: LINUX_TRAY_ICON_PX,
        height: LINUX_TRAY_ICON_PX,
        quality: 'best',
      });
    }
  }
  return image;
};

// idleIconPath: plain outline (calm state). unseenIconPath: statically filled
// (a finished session left unread). breathIconPaths: eased outline→fill frames
// the busy state ping-pongs through.
export const createTrayController = ({ idleIconPath, unseenIconPath, breathIconPaths, statusIconPaths, onAction, locale = 'en' }) => {
  let tray = null;
  let lastTitle = null;
  let lastTooltip = null;
  let lastMenuKey = null;
  let lastSnapshot = null;
  let currentLocale = normalizeTrayLocale(locale);

  // macOS auto-picks the @2x file next to each path and tints the alpha.
  // Windows uses the regular app icon and ignores template tinting.
  const idleFrame = toTemplateImage(idleIconPath);
  const unseenFrame = toTemplateImage(unseenIconPath);
  const breathFrames = breathIconPaths.map(toTemplateImage);
  // Per-row status icons (template images, tinted + vertically centred by macOS).
  const statusIcons = {};
  for (const [key, p] of Object.entries(statusIconPaths || {})) {
    statusIcons[key] = toTemplateImage(p);
  }

  let iconState = null;
  let animTimer = null;
  let animIndex = 0;
  let animDir = 1;

  const stopAnim = () => {
    if (animTimer) {
      clearInterval(animTimer);
      animTimer = null;
    }
  };

  const startAnim = () => {
    if (animTimer || !tray || tray.isDestroyed?.()) return;
    if (breathFrames.length < 2) return;
    animIndex = 0;
    animDir = 1;
    animTimer = setInterval(() => {
      if (!tray || tray.isDestroyed?.()) return;
      tray.setImage(breathFrames[animIndex] || idleFrame);
      // Ping-pong for a seamless, infinite in-and-out breath.
      animIndex += animDir;
      if (animIndex >= breathFrames.length - 1) { animIndex = breathFrames.length - 1; animDir = -1; }
      else if (animIndex <= 0) { animIndex = 0; animDir = 1; }
    }, ANIM_INTERVAL_MS);
  };

  const applyIconState = (nextState) => {
    if (nextState === iconState) return;
    iconState = nextState;
    if (!tray || tray.isDestroyed?.()) return;
    if (nextState === 'busy') {
      if (breathFrames.length > 1) startAnim();
      else tray.setImage(breathFrames[0] || idleFrame);
    } else if (nextState === 'unseen') {
      stopAnim();
      tray.setImage(unseenFrame);
    } else {
      stopAnim();
      tray.setImage(idleFrame);
    }
  };

  const ensureTray = () => {
    if (tray && !tray.isDestroyed?.()) return tray;
    tray = new Tray(idleFrame);
    tray.setIgnoreDoubleClickEvents(true);
    if (!isMac) {
      // Windows: left-click shows. Linux: left-click toggles show/hide so the
      // panel icon stays useful when the window is already open.
      tray.on('click', () => onAction({
        type: isLinux ? 'toggle-main-window' : 'show-main-window',
      }));
    }
    return tray;
  };

  // Turn a plain item from tray-menu.mjs into an Electron menu item: attach the
  // native status icon and wire the `action` to onAction. Structure and labels
  // stay owned by the pure builder.
  const toElectronItem = (item) => {
    if (item.type === 'separator') return { type: 'separator' };
    const out = { label: item.label };
    if (item.enabled === false) out.enabled = false;
    if (item.sublabel) out.sublabel = item.sublabel;
    if (item.statusIconKey) out.icon = statusIcons[item.statusIconKey] || statusIcons.blank;
    if (item.action) out.click = () => onAction(item.action);
    if (Array.isArray(item.submenu)) out.submenu = item.submenu.map(toElectronItem);
    return out;
  };

  const buildMenu = (snapshot) => (
    Menu.buildFromTemplate(
      buildTrayMenu(snapshot, currentLocale, { quitOnClose: isLinux || process.platform === 'win32' })
        .map(toElectronItem),
    )
  );

  const update = (rawSnapshot) => {
    const snapshot = rawSnapshot && typeof rawSnapshot === 'object' ? rawSnapshot : {};
    lastSnapshot = snapshot;
    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];

    const counts = trayCounts(sessions, approvals);

    const widget = ensureTray();
    const title = computeTrayTitle(counts);
    if (title !== lastTitle) {
      widget.setTitle(title);
      lastTitle = title;
    }
    applyIconState(computeTrayIconState(counts));
    const tooltip = computeTrayTooltip(counts, sessions.length, currentLocale);
    if (tooltip !== lastTooltip) {
      widget.setToolTip(tooltip);
      lastTooltip = tooltip;
    }
    const key = trayMenuKey(snapshot, currentLocale);
    if (key !== lastMenuKey) {
      widget.setContextMenu(buildMenu(snapshot));
      lastMenuKey = key;
    }
  };

  // Switch the menu/tooltip language. No-op when the locale is unchanged so a
  // redundant desktop_set_locale does not rebuild the native menu.
  const setLocale = (nextLocale) => {
    const normalized = normalizeTrayLocale(nextLocale);
    if (normalized === currentLocale) return;
    currentLocale = normalized;
    // Force the next update() to rebuild even if the snapshot is identical.
    lastMenuKey = null;
    lastTooltip = null;
    if (lastSnapshot) update(lastSnapshot);
  };

  const destroy = () => {
    stopAnim();
    if (tray && !tray.isDestroyed?.()) {
      tray.destroy();
    }
    tray = null;
    lastTitle = null;
    lastTooltip = null;
    lastMenuKey = null;
    lastSnapshot = null;
    iconState = null;
  };

  return { update, setLocale, destroy };
};
