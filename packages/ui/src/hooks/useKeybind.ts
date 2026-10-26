import React from 'react';
import { shortcutRegistry, type ShortcutActionId, type ShortcutHandler } from '@/lib/shortcuts';

export function useKeybind(actionId: ShortcutActionId, handler: ShortcutHandler): void {
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;

  React.useEffect(() => shortcutRegistry.register(actionId, (event) => handlerRef.current(event)), [actionId]);
}

export type ShortcutBindings<
  Bindings extends Partial<Record<ShortcutActionId, ShortcutHandler>>,
> = Bindings & Record<Exclude<keyof Bindings, ShortcutActionId>, never>;

export function useKeybinds<
  const Bindings extends Partial<Record<ShortcutActionId, ShortcutHandler>>,
>(bindings: ShortcutBindings<Bindings>): void {
  const handlersRef = React.useRef(bindings);
  handlersRef.current = bindings;
  const actionIdsKey = Object.keys(bindings).sort().join('\0');

  React.useEffect(() => {
    const actionIds = (actionIdsKey ? actionIdsKey.split('\0') : []) as ShortcutActionId[];
    const unregister = actionIds.map((actionId) => shortcutRegistry.register(actionId, (event) => {
      const handler = handlersRef.current[actionId];
      return handler ? handler(event) : false;
    }));
    return () => unregister.forEach((remove) => remove());
  }, [actionIdsKey]);
}
