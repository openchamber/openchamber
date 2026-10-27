import { CODE_FONT_OPTION_MAP, UI_FONT_OPTION_MAP, type FontFaceSource, type MonoFontOption, type UiFontOption } from '@/lib/fontOptions';

const loadedFaces = new Set<string>();
const pendingFaces = new Map<string, Promise<void>>();

interface FaceFile {
  /** A single weight, or a `min max` range for a variable file. */
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
      loadedFaces.add(key);
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
