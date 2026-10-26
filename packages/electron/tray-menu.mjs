// Tray menu content, kept free of Electron so it can be built and compared in
// plain tests. `tray.mjs` turns the template into a native menu and rebuilds it
// only when `trayMenuKey` changes.

const isLinux = process.platform === 'linux';

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

export const buildTrayMenuTemplate = (snapshot, { onAction, statusIcons }) => {
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
            // Only when the request carries save patterns; otherwise "always"
            // behaves like "once" and remembers nothing.
            ...(approval.canSave ? [{ label: 'Allow always', click: () => onAction({ type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'always' }) }] : []),
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
  );

  if (isLinux || process.platform === 'win32') {
    // Right-click context menu: show / hide / close (quit). Matches the
    // expected AppImage / Windows tray controls.
    template.push(
      { type: 'separator' },
      { label: 'Show Window', click: () => onAction({ type: 'show-main-window' }) },
      { label: 'Hide Window', click: () => onAction({ type: 'hide-main-window' }) },
      { type: 'separator' },
      { label: 'Close', click: () => onAction({ type: 'quit' }) },
    );
  } else {
    template.push(
      { label: 'Show OpenChamber', click: () => onAction({ type: 'show-main-window' }) },
      { type: 'separator' },
      { label: 'Quit OpenChamber', click: () => onAction({ type: 'quit' }) },
    );
  }

  return template;
};

// Lightweight signature of the menu-affecting content — skips nativeImage
// and click handlers that can't be serialized. Cheaper than building the menu.
export const trayMenuKey = (snapshot) => {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
  const usage = snapshot.usage && typeof snapshot.usage === 'object' ? snapshot.usage : {};
  const groups = Array.isArray(usage.groups) ? usage.groups : [];
  return JSON.stringify({
    h: typeof snapshot.instanceName === 'string' ? snapshot.instanceName : '',
    s: sessions.map((s) => `${s.id}|${s.title}|${s.status}|${s.unseen}|${s.hasError}|${s.subtitle}|${s.directory}`),
    a: approvals.map((a) => `${a.id}|${a.kind}|${a.sessionId}|${a.sessionTitle}|${a.label}|${a.directory}|${a.canSave ? 1 : 0}`),
    u: usage.mode || '',
    g: groups.map((g) => `${g.provider}|${g.status}|${(Array.isArray(g.rows) ? g.rows : []).map((r) => `${r.label}|${r.value}`).join(',')}`),
  });
};
