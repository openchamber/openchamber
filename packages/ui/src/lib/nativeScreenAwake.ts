import { Capacitor, registerPlugin } from '@capacitor/core';

interface ScreenAwakePlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
}

const ScreenAwake = registerPlugin<ScreenAwakePlugin>('ScreenAwake');

/** One ordered writer across mounts, including React StrictMode cleanup. */
export function createScreenAwakeWriter(writeNative: (enabled: boolean) => Promise<void>) {
  let writes = Promise.resolve();
  let revision = 0;
  return (enabled: boolean): Promise<void> => {
    const requested = ++revision;
    const write = writes.then(async () => {
      if (requested !== revision) return;
      await writeNative(enabled);
    });
    writes = write.catch(() => undefined);
    return write;
  };
}

export const setNativeScreenAwake = createScreenAwakeWriter(async (enabled) => {
  if (Capacitor.isNativePlatform()) await ScreenAwake.setEnabled({ enabled });
});
