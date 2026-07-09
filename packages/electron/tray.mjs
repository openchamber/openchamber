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

import { Tray, Menu, nativeImage } from 'electron';

const isMac = process.platform === 'darwin';

const MAX_SESSIONS = 8;
const MAX_APPROVALS = 10;

const truncate = (value, max) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
};

// Which status icon key a session maps to. 'blank' (a transparent image)
// reserves the same left gutter for idle rows so every row aligns.
const statusIconKey = (session) => {
  if (session.status === 'busy') return 'busy';
  if (session.status === 'retry') return 'retry';
  if (session.hasError) return 'error';
  if (session.unseen > 0) return 'unseen';
  return 'blank';
};

const sessionLabel = (session) => {
  // The status is a native left icon (the ✓ already signals unread), so the
  // label is just the session title.
  return truncate(session.title || 'Untitled session', 40);
};

const approvalLabel = (approval) => {
  const icon = approval.kind === 'permission' ? '⛔' : '❓';
  const who = truncate(approval.sessionTitle || 'Session', 24);
  const what = truncate(approval.label || (approval.kind === 'permission' ? 'Permission request' : 'Question'), 34);
  return `${icon} ${who} — ${what}`;
};

// Text shown next to the icon — reserved for the two states where a precise
// count is actionable: pending approvals and errors. Busy and unread are
// conveyed by the icon itself (animated / filled faces), so they add no text.
// Glyphs come from the Geometric Shapes block so macOS renders them monochrome
// (not colour emoji) and tints them with the menu bar like the template icon.
const computeTitle = (counts) => {
  if (counts.approvals > 0) return `◆ ${counts.approvals}`; // decision needed
  if (counts.error > 0) return `▲ ${counts.error}`;         // problem
  return '';
};

// Which icon variant to show. Busy work animates a "breathing" fill; unread
// (with nothing active) holds a static filled cube until the state clears;
// otherwise the plain outline.
const computeIconState = (counts) => {
  if (counts.busy > 0) return 'busy';
  if (counts.unseen > 0) return 'unseen';
  return 'idle';
};

const computeTooltip = (counts, sessionCount) => {
  if (sessionCount === 0) return 'OpenChamber — no active sessions';
  const bits = [];
  if (counts.approvals > 0) bits.push(`${counts.approvals} awaiting approval`);
  if (counts.error > 0) bits.push(`${counts.error} with errors`);
  if (counts.busy > 0) bits.push(`${counts.busy} working`);
  if (counts.unseen > 0) bits.push(`${counts.unseen} unread`);
  const suffix = bits.length ? ` · ${bits.join(', ')}` : ' · idle';
  return `OpenChamber — ${sessionCount} session${sessionCount === 1 ? '' : 's'}${suffix}`;
};

// Frame cadence for the "breathing" busy animation. With the eased frame set
// (denser near the extremes) a slower tick reads as a calm, continuous glow
// rather than a snappy blink.
const ANIM_INTERVAL_MS = 75;

const toTemplateImage = (p) => {
  const image = nativeImage.createFromPath(p);
  if (isMac) image.setTemplateImage(true);
  return image;
};

// idleIconPath: plain outline (calm state). unseenIconPath: statically filled
// (a finished session left unread). breathIconPaths: eased outline→fill frames
// the busy state ping-pongs through.
export const createTrayController = ({ idleIconPath, unseenIconPath, breathIconPaths, statusIconPaths, onAction }) => {
  let tray = null;
  let lastTitle = null;

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
      startAnim();
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
      tray.on('click', () => onAction({ type: 'show-main-window' }));
    }
    return tray;
  };

  const buildMenu = (snapshot) => {
    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
    const header = typeof snapshot.instanceName === 'string' && snapshot.instanceName.trim()
      ? snapshot.instanceName.trim()
      : 'OpenChamber';

    const template = [
      { label: header, enabled: false },
      { type: 'separator' },
    ];

    if (approvals.length > 0) {
      template.push({ label: 'Needs your attention', enabled: false });
      const approvalItem = (approval) => {
        if (approval.kind === 'permission') {
          return {
            label: approvalLabel(approval),
            submenu: [
              { label: 'Allow once', click: () => onAction({ type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'once' }) },
              { label: 'Allow always', click: () => onAction({ type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'always' }) },
              { type: 'separator' },
              { label: 'Deny', click: () => onAction({ type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'reject' }) },
              { type: 'separator' },
              { label: 'Open in app', click: () => onAction({ type: 'focus-session', sessionId: approval.sessionId, directory: approval.directory || '' }) },
            ],
          };
        }
        return {
          label: approvalLabel(approval),
          click: () => onAction({ type: 'focus-session', sessionId: approval.sessionId, directory: approval.directory || '' }),
        };
      };
      for (const approval of approvals.slice(0, MAX_APPROVALS)) {
        template.push(approvalItem(approval));
      }
      const approvalOverflow = approvals.slice(MAX_APPROVALS);
      if (approvalOverflow.length > 0) {
        template.push({
          label: `${approvalOverflow.length} more…`,
          submenu: approvalOverflow.map(approvalItem),
        });
      }
      template.push({ type: 'separator' });
    }

    const sessionItem = (session) => ({
      label: sessionLabel(session),
      // Status icon on the left, centred across both lines; idle uses the blank
      // placeholder so every row keeps the same gutter.
      icon: statusIcons[statusIconKey(session)] || statusIcons.blank,
      // Secondary smaller line (macOS): project · branch.
      ...(session.subtitle ? { sublabel: truncate(session.subtitle, 48) } : {}),
      click: () => onAction({ type: 'focus-session', sessionId: session.id, directory: session.directory || '' }),
    });

    if (sessions.length > 0) {
      template.push({ label: 'Sessions', enabled: false });
      for (const session of sessions.slice(0, MAX_SESSIONS)) {
        template.push(sessionItem(session));
      }
      const overflow = sessions.slice(MAX_SESSIONS);
      if (overflow.length > 0) {
        template.push({
          label: `${overflow.length} more…`,
          submenu: overflow.map(sessionItem),
        });
      }
    } else {
      template.push({ label: 'No active sessions', enabled: false });
    }

    // Usage submenu — only when the user has enabled providers for the dropdown
    // (same "configured to show" rule as the header/mobile); omitted otherwise.
    const usage = snapshot.usage && typeof snapshot.usage === 'object' ? snapshot.usage : null;
    const usageGroups = usage && Array.isArray(usage.groups) ? usage.groups : [];
    if (usageGroups.length > 0) {
      const modeLabel = usage.mode === 'remaining' ? 'Remaining' : 'Used';
      const usageSubmenu = [];
      usageGroups.forEach((group, index) => {
        if (index > 0) usageSubmenu.push({ type: 'separator' });
        // Read-only info rows. NSMenu only offers greyed-out for non-clickable
        // items (no custom text contrast), so these render dimmed — at the mercy
        // of macOS's menu contrast choices. Provider flush, rows indented.
        usageSubmenu.push({ label: group.provider, enabled: false });
        if (group.status) {
          usageSubmenu.push({ label: `    ${truncate(group.status, 40)}`, enabled: false });
        }
        for (const row of (Array.isArray(group.rows) ? group.rows : [])) {
          usageSubmenu.push({ label: `    ${row.label}  —  ${row.value}`, enabled: false });
        }
      });
      template.push(
        { type: 'separator' },
        { label: `Usage (${modeLabel})`, submenu: usageSubmenu },
      );
    }

    template.push(
      { type: 'separator' },
      { label: 'New Session', click: () => onAction({ type: 'new-session' }) },
      { label: 'New Mini Chat', click: () => onAction({ type: 'new-mini-chat' }) },
      { label: 'Show OpenChamber', click: () => onAction({ type: 'show-main-window' }) },
      { type: 'separator' },
      { label: 'Quit OpenChamber', click: () => onAction({ type: 'quit' }) },
    );

    return Menu.buildFromTemplate(template);
  };

  const update = (rawSnapshot) => {
    const snapshot = rawSnapshot && typeof rawSnapshot === 'object' ? rawSnapshot : {};
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
    widget.setToolTip(computeTooltip(counts, sessions.length));
    widget.setContextMenu(buildMenu(snapshot));
  };

  const destroy = () => {
    stopAnim();
    if (tray && !tray.isDestroyed?.()) {
      tray.destroy();
    }
    tray = null;
    lastTitle = null;
    iconState = null;
  };

  return { update, destroy };
};
