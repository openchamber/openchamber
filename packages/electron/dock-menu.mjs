import { z } from 'zod';
import { menuLabel } from './menu-locales.mjs';

const jumpListSessionIdSchema = z.string().regex(/^ses_[A-Za-z0-9_]{1,120}$/);

// The renderer's snapshot crosses IPC: each entry is parsed, and a malformed one is dropped.
const unreadSessionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  directory: z.string().optional(),
});

const readUnreadSessions = (snapshot) => {
  const list = z.array(z.unknown()).safeParse(snapshot?.dockUnreadSessions);
  if (!list.success) return [];
  return list.data.flatMap((entry) => {
    const parsed = unreadSessionSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
};

export const isJumpListSessionId = (value) => jumpListSessionIdSchema.safeParse(value).success;

export const buildUnreadJumpList = (snapshot, { execPath, locale = 'en', removedItems = [] }) => {
  const rows = readUnreadSessions(snapshot).filter((session) => isJumpListSessionId(session.id)).slice(0, 10);
  if (rows.length === 0) return null;
  const task = (title, args) => ({ type: 'task', program: execPath, title, args });
  const removedArgs = new Set(removedItems.map((item) => item.args));
  const items = rows.map((session) => task(
    (session.title.trim() || menuLabel(locale, 'dock.untitledSession')).slice(0, 100),
    `"openchamber://session/${session.id}?source=jump-list"`,
  )).filter((item) => !removedArgs.has(item.args));
  return [
    ...(items.length > 0 ? [{
      type: 'custom', name: menuLabel(locale, 'dock.unread'),
      items,
    }] : []),
    { type: 'tasks', items: [task(menuLabel(locale, 'dock.markAllRead'), '--mark-all-read')] },
  ];
};

// Renderer snapshots already order unread sessions by their latest completed turn.
export const buildDockMenuTemplate = (snapshot, { onAction, locale = 'en' }) => {
  const rows = readUnreadSessions(snapshot).slice(0, 10);
  if (rows.length === 0) return [];
  return [
    ...rows.map((session) => {
      const title = session.title.trim() || menuLabel(locale, 'dock.untitledSession');
      const label = title.length > 40 ? `${title.slice(0, 39)}…` : title;
      return {
        label: label.replace(/&/g, '&&'),
        click: () => onAction({ type: 'focus-session', sessionId: session.id, directory: session.directory ?? '' }),
      };
    }),
    { type: 'separator' },
    { label: menuLabel(locale, 'dock.markAllRead'), click: () => onAction({ type: 'mark-all-read' }) },
  ];
};
