// Pure construction of the native tray menu and tooltip.
//
// Kept free of Electron so it can be unit tested in plain Node, mirroring how
// menu-locales.mjs / host-probe-policy.mjs isolate the logic from the runtime.
// tray.mjs turns these plain descriptions into a real Tray + Menu: it attaches
// the status icons and converts each item's `action` into a click handler.
//
// All user-facing text comes from tray-locales.mjs, so a language change only
// swaps the dictionary — the structure here is locale-independent.

import { formatTrayLabel, trayLabel } from './tray-locales.mjs';

export const MAX_SESSIONS = 8;
export const MAX_APPROVALS = 10;

const truncate = (value, max) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
};

// Which status icon key a session maps to. 'blank' (a transparent image)
// reserves the same left gutter for idle rows so every row aligns.
export const trayStatusIconKey = (session) => {
  if (session.status === 'busy') return 'busy';
  if (session.status === 'retry') return 'retry';
  if (session.hasError) return 'error';
  if (session.unseen > 0) return 'unseen';
  return 'blank';
};

export const traySessionLabel = (session, locale) => {
  // The status is a native left icon (the ✓ already signals unread), so the
  // label is just the session title.
  return truncate(session.title || trayLabel(locale, 'untitledSession'), 40);
};

const approvalLabel = (approval, locale) => {
  const icon = approval.kind === 'permission' ? '⛔' : '❓';
  const who = truncate(approval.sessionTitle || trayLabel(locale, 'sessionFallback'), 24);
  const what = truncate(
    approval.label || trayLabel(locale, approval.kind === 'permission' ? 'permissionRequest' : 'question'),
    34,
  );
  return `${icon} ${who} — ${what}`;
};

// Text shown next to the icon — reserved for the two states where a precise
// count is actionable: pending approvals and errors. Busy and unread are
// conveyed by the icon itself (animated / filled faces), so they add no text.
// Glyphs come from the Geometric Shapes block so macOS renders them monochrome
// (not colour emoji) and tints them with the menu bar like the template icon.
export const computeTrayTitle = (counts) => {
  if (counts.approvals > 0) return `◆ ${counts.approvals}`; // decision needed
  if (counts.error > 0) return `▲ ${counts.error}`;         // problem
  return '';
};

// Which icon variant to show. Busy work animates a "breathing" fill; unread
// (with nothing active) holds a static filled cube until the state clears;
// otherwise the plain outline.
export const computeTrayIconState = (counts) => {
  if (counts.busy > 0) return 'busy';
  if (counts.unseen > 0) return 'unseen';
  return 'idle';
};

export const computeTrayTooltip = (counts, sessionCount, locale) => {
  if (sessionCount === 0) return trayLabel(locale, 'tooltipNoSessions');
  const bits = [];
  if (counts.approvals > 0) bits.push(formatTrayLabel(locale, 'awaitingApproval', { count: counts.approvals }));
  if (counts.error > 0) bits.push(formatTrayLabel(locale, 'withErrors', { count: counts.error }));
  if (counts.busy > 0) bits.push(formatTrayLabel(locale, 'working', { count: counts.busy }));
  if (counts.unseen > 0) bits.push(formatTrayLabel(locale, 'unread', { count: counts.unseen }));
  const suffix = bits.length ? ` · ${bits.join(', ')}` : ` · ${trayLabel(locale, 'idle')}`;
  const sessions = formatTrayLabel(locale, sessionCount === 1 ? 'sessionOne' : 'sessionMany', { count: sessionCount });
  return `OpenChamber — ${sessions}${suffix}`;
};

export const trayCounts = (sessions, approvals) => ({
  busy: sessions.filter((s) => s.status === 'busy' || s.status === 'retry').length,
  error: sessions.filter((s) => s.hasError).length,
  approvals: approvals.length,
  unseen: sessions.reduce((sum, s) => sum + (Number.isFinite(s.unseen) ? s.unseen : 0), 0),
});

/**
 * Build the tray menu as plain items. Each actionable item carries an `action`
 * object identical to what the tray controller forwards to onAction, plus an
 * optional `statusIconKey` for session rows. The controller adds native icons
 * and click handlers; tests assert on the labels and structure directly.
 */
export const buildTrayMenu = (snapshot, locale, { quitOnClose = true } = {}) => {
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
    template.push({ label: trayLabel(locale, 'needsAttention'), enabled: false });
    const approvalItem = (approval) => {
      if (approval.kind === 'permission') {
        return {
          label: approvalLabel(approval, locale),
          submenu: [
            { label: trayLabel(locale, 'allowOnce'), action: { type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'once' } },
            { label: trayLabel(locale, 'allowAlways'), action: { type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'always' } },
            { type: 'separator' },
            { label: trayLabel(locale, 'deny'), action: { type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'reject' } },
            { type: 'separator' },
            { label: trayLabel(locale, 'openInApp'), action: { type: 'focus-session', sessionId: approval.sessionId, directory: approval.directory || '' } },
          ],
        };
      }
      return {
        label: approvalLabel(approval, locale),
        action: { type: 'focus-session', sessionId: approval.sessionId, directory: approval.directory || '' },
      };
    };
    for (const approval of approvals.slice(0, MAX_APPROVALS)) {
      template.push(approvalItem(approval));
    }
    const approvalOverflow = approvals.slice(MAX_APPROVALS);
    if (approvalOverflow.length > 0) {
      template.push({
        label: formatTrayLabel(locale, 'more', { count: approvalOverflow.length }),
        submenu: approvalOverflow.map(approvalItem),
      });
    }
    template.push({ type: 'separator' });
  }

  const sessionItem = (session) => ({
    label: traySessionLabel(session, locale),
    // Status icon on the left, centred across both lines; idle uses the blank
    // placeholder so every row keeps the same gutter.
    statusIconKey: trayStatusIconKey(session),
    // Secondary smaller line (macOS): project · branch.
    ...(session.subtitle ? { sublabel: truncate(session.subtitle, 48) } : {}),
    action: { type: 'focus-session', sessionId: session.id, directory: session.directory || '' },
  });

  if (sessions.length > 0) {
    template.push({ label: trayLabel(locale, 'sessions'), enabled: false });
    for (const session of sessions.slice(0, MAX_SESSIONS)) {
      template.push(sessionItem(session));
    }
    const overflow = sessions.slice(MAX_SESSIONS);
    if (overflow.length > 0) {
      template.push({
        label: formatTrayLabel(locale, 'more', { count: overflow.length }),
        submenu: overflow.map(sessionItem),
      });
    }
  } else {
    template.push({ label: trayLabel(locale, 'noActiveSessions'), enabled: false });
  }

  // Usage submenu — only when the user has enabled providers for the dropdown
  // (same "configured to show" rule as the header/mobile); omitted otherwise.
  const usage = snapshot.usage && typeof snapshot.usage === 'object' ? snapshot.usage : null;
  const usageGroups = usage && Array.isArray(usage.groups) ? usage.groups : [];
  if (usageGroups.length > 0) {
    const modeLabel = trayLabel(locale, usage.mode === 'remaining' ? 'remaining' : 'used');
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
      { label: `${trayLabel(locale, 'usage')} (${modeLabel})`, submenu: usageSubmenu },
    );
  }

  template.push(
    { type: 'separator' },
    { label: trayLabel(locale, 'newSession'), action: { type: 'new-session' } },
    { label: trayLabel(locale, 'newMiniChat'), action: { type: 'new-mini-chat' } },
  );

  if (quitOnClose) {
    // Right-click context menu: show / hide / close (quit). Matches the
    // expected AppImage / Windows tray controls.
    template.push(
      { type: 'separator' },
      { label: trayLabel(locale, 'showWindow'), action: { type: 'show-main-window' } },
      { label: trayLabel(locale, 'hideWindow'), action: { type: 'hide-main-window' } },
      { type: 'separator' },
      { label: trayLabel(locale, 'close'), action: { type: 'quit' } },
    );
  } else {
    template.push(
      { label: trayLabel(locale, 'showApp'), action: { type: 'show-main-window' } },
      { type: 'separator' },
      { label: trayLabel(locale, 'quitApp'), action: { type: 'quit' } },
    );
  }

  return template;
};

// Lightweight signature of the menu-affecting content — cheaper than rebuilding
// the menu, and includes the locale so a language change forces a rebuild.
export const trayMenuKey = (snapshot, locale) => {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
  const usage = snapshot.usage && typeof snapshot.usage === 'object' ? snapshot.usage : {};
  const groups = Array.isArray(usage.groups) ? usage.groups : [];
  return JSON.stringify({
    l: locale,
    h: typeof snapshot.instanceName === 'string' ? snapshot.instanceName : '',
    s: sessions.map((s) => `${s.id}|${s.title}|${s.status}|${s.unseen}|${s.hasError}|${s.subtitle}|${s.directory}`),
    a: approvals.map((a) => `${a.id}|${a.kind}|${a.sessionId}|${a.sessionTitle}|${a.label}|${a.directory}`),
    u: usage.mode || '',
    g: groups.map((g) => `${g.provider}|${g.status}|${(Array.isArray(g.rows) ? g.rows : []).map((r) => `${r.label}|${r.value}`).join(',')}`),
  });
};
