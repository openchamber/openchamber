import { botItemSchema } from './schema.js';

/** notify owns settings, focus, enterprise redaction and push delivery. */
export function createBotAttention({ center, notify }) {
  if (!center?.upsertBot || !center?.resolveBot || !(notify instanceof Function)) {
    throw new Error('Bot attention requires a notification center and notify owner');
  }
  return {
    async sync({ projectId, item: candidate, critical = false }) {
      const item = botItemSchema.parse(candidate);
      const target = { projectId, itemId: item.id };
      const pending = item.state === 'needs-you' || item.state === 'waiting-answer';
      let result = null;
      if (pending) {
        result = await center.upsertBot({
          ...target, botState: item.state, title: item.title, body: item.wait?.reason ?? item.state,
          directory: item.worktree ?? null,
          sessionId: item.sessions.fixing ?? item.sessions.investigation ?? item.sessions.judge ?? null,
        });
      } else {
        await center.resolveBot(target);
      }
      if (critical || (item.state === 'needs-you' && result.changed)) {
        await notify({
          kind: 'bot', priority: 'high', requestId: item.id,
          action: { type: 'bots', ...target },
          title: item.title, body: item.wait?.reason ?? item.state,
          sessionId: item.sessions.fixing ?? item.sessions.investigation ?? item.sessions.judge ?? null,
          directory: item.worktree ?? null, critical,
        });
      }
      return result?.entry ?? null;
    },
  };
}
