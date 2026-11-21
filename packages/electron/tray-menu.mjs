
import { menuLabel, normalizeMenuLocale } from './menu-locales.mjs';
import { trayLabel } from './tray-locales.mjs';

const isLinux = process.platform === 'linux';

const MAX_SESSIONS = 8;
const MAX_APPROVALS = 10;

export const computeTrayTooltip = (counts, sessionCount, locale = 'en') => {
  const t = (key, count) => trayLabel(locale, key, count);
  if (sessionCount === 0) return t('tooltipNoSessions');
  const bits = [];
  if (counts.approvals > 0) bits.push(t('awaitingApproval', counts.approvals));
  if (counts.error > 0) bits.push(t('withErrors', counts.error));
  if (counts.busy > 0) bits.push(t('working', counts.busy));
  if (counts.unseen > 0) bits.push(t('unread', counts.unseen));
  const category = new Intl.PluralRules(normalizeMenuLocale(locale)).select(sessionCount);
  const sessionKey = category === 'one' ? 'sessionOne' : category === 'few' ? 'sessionFew' : 'sessionMany';
  return `OpenChamber — ${t(sessionKey, sessionCount)} · ${bits.length ? bits.join(', ') : t('idle')}`;
};

const truncate = (value, max) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
};

const statusIconKey = (session) => {
  if (session.status === 'busy') return 'busy';
  if (session.status === 'retry') return 'retry';
  if (session.hasError) return 'error';
  if (session.unseen > 0) return 'unseen';
  return 'blank';
};

const sessionLabel = (session, locale) => {
  return truncate(session.title || trayLabel(locale, 'untitledSession'), 40);
};

const approvalLabel = (approval, locale) => {
  const icon = approval.kind === 'permission' ? '⛔' : '❓';
  const who = truncate(approval.sessionTitle || trayLabel(locale, 'sessionFallback'), 24);
  const what = truncate(approval.label || trayLabel(locale, approval.kind === 'permission' ? 'permissionRequest' : 'question'), 34);
  return `${icon} ${who} — ${what}`;
};

export const buildTrayMenuTemplate = (snapshot, { onAction, statusIcons, locale = 'en' }) => {
  const t = (key, count) => trayLabel(locale, key, count);
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
    template.push({ label: t('needsAttention'), enabled: false });
    const approvalItem = (approval) => {
      if (approval.kind === 'permission') {
        return {
          label: approvalLabel(approval, locale),
          submenu: [
            { label: t('allowOnce'), click: () => onAction({ type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'once' }) },
            ...(approval.canSave ? [{ label: t('allowAlways'), click: () => onAction({ type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'always' }) }] : []),
            { type: 'separator' },
            { label: t('deny'), click: () => onAction({ type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'reject' }) },
            { type: 'separator' },
            { label: t('openInApp'), click: () => onAction({ type: 'focus-session', sessionId: approval.sessionId, directory: approval.directory || '' }) },
          ],
        };
      }
      return {
        label: approvalLabel(approval, locale),
        click: () => onAction({ type: 'focus-session', sessionId: approval.sessionId, directory: approval.directory || '' }),
      };
    };
    for (const approval of approvals.slice(0, MAX_APPROVALS)) {
      template.push(approvalItem(approval));
    }
    const approvalOverflow = approvals.slice(MAX_APPROVALS);
    if (approvalOverflow.length > 0) {
      template.push({
        label: t('more', approvalOverflow.length),
        submenu: approvalOverflow.map(approvalItem),
      });
    }
    template.push({ type: 'separator' });
  }

  const sessionItem = (session) => ({
    label: sessionLabel(session, locale),
    icon: statusIcons[statusIconKey(session)] || statusIcons.blank,
    ...(session.subtitle ? { sublabel: truncate(session.subtitle, 48) } : {}),
    click: () => onAction({ type: 'focus-session', sessionId: session.id, directory: session.directory || '' }),
  });

  if (sessions.length > 0) {
    template.push({ label: t('sessions'), enabled: false });
    for (const session of sessions.slice(0, MAX_SESSIONS)) {
      template.push(sessionItem(session));
    }
    const overflow = sessions.slice(MAX_SESSIONS);
    if (overflow.length > 0) {
      template.push({
        label: t('more', overflow.length),
        submenu: overflow.map(sessionItem),
      });
    }
  } else {
    template.push({ label: t('noActiveSessions'), enabled: false });
  }

  const usage = snapshot.usage && typeof snapshot.usage === 'object' ? snapshot.usage : null;
  const usageGroups = usage && Array.isArray(usage.groups) ? usage.groups : [];
  if (usageGroups.length > 0) {
    const usageSubmenu = [];
    usageGroups.forEach((group, index) => {
      if (index > 0) usageSubmenu.push({ type: 'separator' });
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
      { label: t(usage.mode === 'remaining' ? 'usageRemaining' : 'usageUsed'), submenu: usageSubmenu },
    );
  }

  template.push(
    { type: 'separator' },
    { label: menuLabel(locale, 'newSession'), click: () => onAction({ type: 'new-session' }) },
    { label: menuLabel(locale, 'newMiniChat'), click: () => onAction({ type: 'new-mini-chat' }) },
  );

  if (isLinux || process.platform === 'win32') {
    template.push(
      { type: 'separator' },
      { label: t('showWindow'), click: () => onAction({ type: 'show-main-window' }) },
      { label: t('hideWindow'), click: () => onAction({ type: 'hide-main-window' }) },
      { type: 'separator' },
      { label: menuLabel(locale, 'close'), click: () => onAction({ type: 'quit' }) },
    );
  } else {
    template.push(
      { label: t('showApp'), click: () => onAction({ type: 'show-main-window' }) },
      { type: 'separator' },
      { label: t('quitApp'), click: () => onAction({ type: 'quit' }) },
    );
  }

  return template;
};

export const trayMenuKey = (snapshot, locale = 'en') => {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
  const usage = snapshot.usage && typeof snapshot.usage === 'object' ? snapshot.usage : {};
  const groups = Array.isArray(usage.groups) ? usage.groups : [];
  return JSON.stringify({
    locale,
    h: typeof snapshot.instanceName === 'string' ? snapshot.instanceName : '',
    s: sessions.map((s) => `${s.id}|${s.title}|${s.status}|${s.unseen}|${s.hasError}|${s.subtitle}|${s.directory}`),
    a: approvals.map((a) => `${a.id}|${a.kind}|${a.sessionId}|${a.sessionTitle}|${a.label}|${a.directory}|${a.canSave ? 1 : 0}`),
    u: usage.mode || '',
    g: groups.map((g) => `${g.provider}|${g.status}|${(Array.isArray(g.rows) ? g.rows : []).map((r) => `${r.label}|${r.value}`).join(',')}`),
  });
};
