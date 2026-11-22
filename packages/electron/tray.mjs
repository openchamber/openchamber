
import { Tray, Menu, nativeImage } from 'electron';
import { buildTrayMenuTemplate, computeTrayTooltip, trayMenuKey } from './tray-menu.mjs';
import { normalizeMenuLocale } from './menu-locales.mjs';

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const LINUX_TRAY_ICON_PX = 22;

const computeTitle = (counts) => {
  if (counts.approvals > 0) return `◆ ${counts.approvals}`;
  if (counts.error > 0) return `▲ ${counts.error}`;
  return '';
};

const computeIconState = (counts) => {
  if (counts.busy > 0) return 'busy';
  if (counts.unseen > 0) return 'unseen';
  return 'idle';
};

const ANIM_INTERVAL_MS = 200;

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

export const createTrayLocaleRouter = (applyLocale) => {
  const localeBySender = new WeakMap();
  let owner = null;
  return {
    setLocale: (sender, locale) => {
      if (!sender || !locale) return;
      localeBySender.set(sender, locale);
      if (sender === owner) applyLocale(locale);
    },
    publish: (sender) => {
      owner = sender ?? null;
      const locale = owner ? localeBySender.get(owner) : undefined;
      if (locale) applyLocale(locale);
    },
  };
};

export const createTrayController = ({ idleIconPath, unseenIconPath, breathIconPaths, statusIconPaths, onAction, locale: initialLocale }) => {
  let tray = null;
  let locale = normalizeMenuLocale(initialLocale);
  let lastSnapshot = null;
  let lastTitle = null;
  let lastTooltip = null;
  let lastMenuKey = null;

  const idleFrame = toTemplateImage(idleIconPath);
  const unseenFrame = toTemplateImage(unseenIconPath);
  const breathFrames = breathIconPaths.map(toTemplateImage);
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
      tray.on('click', () => onAction({
        type: isLinux ? 'toggle-main-window' : 'show-main-window',
      }));
    }
    return tray;
  };

  const buildMenu = (snapshot) => {
    const menu = Menu.buildFromTemplate(buildTrayMenuTemplate(snapshot, { onAction, statusIcons, locale }));
    menu.on('menu-will-show', () => onAction({ type: 'menu-opened' }));
    return menu;
  };

  const update = (rawSnapshot) => {
    const snapshot = rawSnapshot && typeof rawSnapshot === 'object' ? rawSnapshot : {};
    lastSnapshot = snapshot;
    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];

    const counts = {
      busy: sessions.filter((s) => s.status === 'busy' || s.status === 'retry').length,
      error: sessions.filter((s) => s.hasError).length,
      approvals: approvals.length,
      unseen: sessions.reduce((sum, s) => sum + (Number.isFinite(s.unseen) ? s.unseen : 0), 0),
    };

    const widget = ensureTray();
    const title = computeTitle(counts);
    if (title !== lastTitle) {
      widget.setTitle(title);
      lastTitle = title;
    }
    applyIconState(computeIconState(counts));
    const tooltip = computeTrayTooltip(counts, sessions.length, locale);
    if (tooltip !== lastTooltip) {
      widget.setToolTip(tooltip);
      lastTooltip = tooltip;
    }
    const key = trayMenuKey(snapshot, locale);
    if (key !== lastMenuKey) {
      widget.setContextMenu(buildMenu(snapshot));
      lastMenuKey = key;
    }
  };

  const destroy = () => {
    stopAnim();
    if (tray && !tray.isDestroyed?.()) {
      tray.destroy();
    }
    tray = null;
    lastSnapshot = null;
    lastTitle = null;
    lastTooltip = null;
    lastMenuKey = null;
    iconState = null;
  };

  const setLocale = (nextLocale) => {
    const normalized = normalizeMenuLocale(nextLocale);
    if (locale === normalized) return;
    locale = normalized;
    if (lastSnapshot) update(lastSnapshot);
  };

  update({ sessions: [], approvals: [] });
  return { update, destroy, setLocale };
};
