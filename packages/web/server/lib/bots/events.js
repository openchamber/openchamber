import { EventEmitter } from 'node:events';

/** In-process delivery only. Item snapshots remain the reconnect authority. */
export const createBotEvents = () => {
  const emitter = new EventEmitter();
  return {
    publish: (event) => emitter.emit('change', event),
    subscribe: (listener) => {
      emitter.on('change', listener);
      return () => emitter.off('change', listener);
    },
  };
};

export const botTaskFor = (bot) => {
  const { kind, time, weekdays, cron, timezone } = bot.schedule;
  const schedule = kind === 'cron' ? { kind, cron } : { kind: kind === 'weekly' ? 'weekly' : 'daily', times: [time] };
  if (kind === 'weekly') schedule.weekdays = weekdays;
  if (timezone) schedule.timezone = timezone;
  return {
    id: `bot-${bot.id}`, name: bot.name, botId: bot.id, botManaged: true,
    enabled: bot.enabled && kind !== 'manual', schedule,
    execution: { prompt: 'This task belongs to Bots. Dispatch it through the bot scheduler hook.', useDefaults: true, notify: bot.notify },
  };
};
