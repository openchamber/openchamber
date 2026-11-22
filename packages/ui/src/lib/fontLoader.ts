import { CODE_FONT_OPTION_MAP, UI_FONT_OPTION_MAP, type FontFaceSource, type MonoFontOption, type UiFontOption } from '@/lib/fontOptions';
import { isVSCodeRuntime } from './desktop';
import { fetchBypassingRuntimeBridge } from './runtime-fetch';
import { waitAtMost } from './timing/waitAtMost';
import { withAbortDeadline } from './timing/withAbortDeadline';

const loadedFaces = new Map<string, { family: string; file: FaceFile }>();
const embedCSSByFace = new Map<string, Promise<string>>();
const PENDING_FACE_WAIT_MS = 2_000;
const pendingFaces = new Map<string, Promise<void>>();

interface FaceFile {
  weight: string;
  url: string;
}

const jsdelivrFile = (packageName: string, fileName: string) => {
  const encoded = encodeURIComponent(packageName).replace('%40', '@').replace('%2F', '/');
  return `https://cdn.jsdelivr.net/npm/${encoded}/files/${fileName}`;
};

const faceFiles = (source: FontFaceSource): FaceFile[] => {
  if ('weightRange' in source) {
    const [min, max] = source.weightRange;
    return [{ weight: `${min} ${max}`, url: jsdelivrFile(source.packageName, `${source.filePrefix}-latin-wght-normal.woff2`) }];
  }
  if ('urls' in source) {
    return source.weights.map((weight) => ({ weight: String(weight), url: source.urls[weight] }));
  }
  return source.weights.map((weight) => ({
    weight: String(weight),
    url: jsdelivrFile(source.packageName, `${source.filePrefix}-latin-${weight}-normal.woff2`),
  }));
};

const readFontDataURL = (url: string): Promise<string> => withAbortDeadline(2_000, async (signal) => {
  const response = await fetchBypassingRuntimeBridge(url, {
    cache: 'force-cache',
    credentials: 'omit',
    signal,
  });
  if (!response.ok) throw new Error(`Font request failed: ${response.status}`);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = reader.result;
      if (data === null || data instanceof ArrayBuffer) reject(new Error('Unable to encode font'));
      else resolve(data);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
});

const embedCSSFor = (key: string, family: string, file: FaceFile): Promise<string> => {
  if (isVSCodeRuntime()) return Promise.resolve('');
  const cached = embedCSSByFace.get(key);
  if (cached) return cached;
  const reading = readFontDataURL(file.url)
    .then((data) => `@font-face{font-family:${JSON.stringify(family)};font-weight:${file.weight};src:url("${data}") format("woff2");}`)
    .catch(() => {
      embedCSSByFace.delete(key);
      return '';
    });
  embedCSSByFace.set(key, reading);
  return reading;
};

const loadFace = (family: string, file: FaceFile) => {
  const key = `${family}:${file.weight}`;
  if (loadedFaces.has(key)) {
    return Promise.resolve();
  }

  const pending = pendingFaces.get(key);
  if (pending) {
    return pending;
  }

  if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) {
    return Promise.resolve();
  }

  const face = new FontFace(family, `url(${file.url}) format('woff2')`, {
    style: 'normal',
    weight: file.weight,
    display: 'swap',
  });

  document.fonts.add(face);
  const promise = face.load()
    .then(() => {
      loadedFaces.set(key, { family, file });
      void embedCSSFor(key, family, file);
    })
    .catch((error) => {
      document.fonts.delete(face);
      console.warn(`Failed to load font: ${family} ${file.weight}`, error);
    })
    .finally(() => {
      pendingFaces.delete(key);
    });

  pendingFaces.set(key, promise);
  return promise;
};

const loadSource = (source: FontFaceSource | undefined) => {
  if (!source) {
    return Promise.resolve();
  }

  return Promise.all(faceFiles(source).map((file) => loadFace(source.family, file))).then(() => undefined);
};

export const loadUiFont = (font: UiFontOption) => loadSource(UI_FONT_OPTION_MAP[font]?.source);

export const loadMonoFont = (font: MonoFontOption) => loadSource(CODE_FONT_OPTION_MAP[font]?.source);

export const loadedAppFontCSS = async (stacks: readonly string[]): Promise<string> => {
  const families = new Set(stacks.flatMap((stack) =>
    stack.split(',').map((name) => name.trim().replace(/^(['"])(.*)\1$/, '$2').toLowerCase()),
  ));
  const loading = [...pendingFaces.values()];
  if (loading.length > 0) {
    await waitAtMost(PENDING_FACE_WAIT_MS, Promise.all(loading));
  }
  const matched = Array.from(loadedFaces.entries()).filter(([, { family }]) => families.has(family.toLowerCase()));
  const css = await Promise.all(matched.map(([key, { family, file }]) => embedCSSFor(key, family, file)));
  return css.filter(Boolean).join('\n');
};
