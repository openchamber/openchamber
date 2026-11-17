
type FileSharePlugin = {
  share: (options: { fileName: string; mimeType: string; data: string }) => Promise<void>;
};

type CapacitorGlobal = {
  getPlatform?: () => string;
  registerPlugin?: (name: string) => FileSharePlugin;
};

let androidPlugin: FileSharePlugin | null = null;

// SAFETY: `window.Capacitor` is injected by the native shell with this shape and
// is absent in every other runtime, which the optional members account for.
const getCapacitor = (): CapacitorGlobal | undefined =>
  (window as typeof window & { Capacitor?: CapacitorGlobal }).Capacitor;

const getAndroidPlugin = (capacitor: CapacitorGlobal): FileSharePlugin | null => {
  if (capacitor.getPlatform?.() !== 'android' || !capacitor.registerPlugin) {
    return null;
  }
  androidPlugin ??= capacitor.registerPlugin('FileShare');
  return androidPlugin;
};

const readAsBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

export const shareFileFromNativeApp = async (file: File): Promise<void> => {
  const capacitor = getCapacitor();
  const plugin = capacitor ? getAndroidPlugin(capacitor) : null;
  if (plugin) {
    await plugin.share({
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      data: await readAsBase64(file),
    });
    return;
  }

  if (!navigator.canShare?.({ files: [file] })) {
    throw new Error('File sharing is unavailable in this mobile runtime');
  }
  await navigator.share({ files: [file] });
};
