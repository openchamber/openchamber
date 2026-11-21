import { z } from 'zod';

const settingsChangedSchema = z.object({
  source: z.enum(['settings', 'preferences']),
  changedKeys: z.array(z.string().min(1).max(128)).min(1),
});

export type AppearanceChangedEvent =
  | { type: 'themes-changed' }
  | ({ type: 'settings-changed' } & z.infer<typeof settingsChangedSchema>);

const parseAppearanceChangedEvent = (envelope: {
  type: string;
  properties: unknown;
}): AppearanceChangedEvent | null => {
  if (envelope.type === 'openchamber:themes-changed') return { type: 'themes-changed' };
  if (envelope.type !== 'openchamber:settings-changed') return null;
  const parsed = settingsChangedSchema.safeParse(envelope.properties);
  return parsed.success ? { type: 'settings-changed', ...parsed.data } : null;
};

export const dispatchAppearanceChangedEvent = (
  envelope: { type: string; properties: unknown },
  listeners: Iterable<(event: AppearanceChangedEvent) => void>,
) => {
  const event = parseAppearanceChangedEvent(envelope);
  if (!event) return false;
  for (const listener of listeners) listener(event);
  return true;
};
