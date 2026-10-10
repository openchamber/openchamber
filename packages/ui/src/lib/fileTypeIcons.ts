import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { FILE_TYPE_ICON_IDS } from '@/lib/fileTypeIconIds';

type ThemeVariant = 'light' | 'dark';

const FILE_TYPE_SPRITE_ROOT_ID = 'oc-file-type-icon-sprite-root';

// The sprite holds every file-type icon (about 1 MB of SVG markup), so it
// loads the first time an icon is asked for instead of with the app. Icons
// reference symbols by in-document id (`#name`), which keeps them working in
// every runtime, including VS Code webviews where an external sprite URL would
// be cross-origin. A `<use>` rendered before the sprite arrives shows its icon
// as soon as the symbol with that id enters the document.
let spriteRequested = false;

// The sprite arrives asynchronously, so the document can be gone by then
// (a torn-down test environment), not only absent from the start.
const hasDocument = (): boolean => typeof document !== 'undefined';

const mountFileTypeSprite = (spriteContent: string): void => {
  if (!hasDocument() || document.getElementById(FILE_TYPE_SPRITE_ROOT_ID)) {
    return;
  }
  const root = document.createElement('div');
  root.id = FILE_TYPE_SPRITE_ROOT_ID;
  root.setAttribute('aria-hidden', 'true');
  root.style.position = 'absolute';
  root.style.width = '0';
  root.style.height = '0';
  root.style.overflow = 'hidden';
  root.innerHTML = spriteContent;
  document.body.appendChild(root);
};

const ensureFileTypeSprite = (): void => {
  if (spriteRequested || !hasDocument()) {
    return;
  }
  spriteRequested = true;
  void import('../assets/icons/file-types/sprite.svg?raw').then(
    (module) => mountFileTypeSprite(module.default),
    (error) => {
      // Let the next icon request try again.
      spriteRequested = false;
      console.warn('[file-type-icons] failed to load the icon sprite', error);
    },
  );
};

let preloadScheduled = false;

/**
 * Loads the sprite in the background once the app is interactive, so the first
 * icon a person sees is already there. An icon requested before this fires
 * loads the sprite itself. Runs once per document.
 */
export const preloadFileTypeSprite = (): void => {
  if (preloadScheduled || typeof window === 'undefined') {
    return;
  }
  preloadScheduled = true;
  // Safari and iOS have no requestIdleCallback.
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(ensureFileTypeSprite, { timeout: 3_000 });
  } else {
    window.setTimeout(ensureFileTypeSprite, 1_000);
  }
};

const fileNameIconMap: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  'package-lock.json': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'tsconfig.json': 'tsconfig',
  'jsconfig.json': 'jsconfig',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.editorconfig': 'editorconfig',
  '.npmrc': 'npm',
  '.yarnrc': 'yarn',
  '.prettierrc': 'prettier',
  '.eslintrc': 'eslint',
  '.babelrc': 'babel',
};

const languageIconMap: Record<string, string> = {
  javascript: 'javascript',
  jsx: 'react',
  typescript: 'typescript',
  tsx: 'react_ts',
  html: 'html',
  handlebars: 'handlebars',
  twig: 'twig',
  liquid: 'liquid',
  css: 'css',
  scss: 'sass',
  sass: 'sass',
  less: 'less',
  stylus: 'stylus',
  json: 'json',
  yaml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  ini: 'settings',
  properties: 'settings',
  bash: 'console',
  powershell: 'powershell',
  batch: 'console',
  python: 'python',
  ruby: 'ruby',
  erb: 'ruby',
  php: 'php',
  java: 'java',
  kotlin: 'kotlin',
  scala: 'scala',
  groovy: 'groovy',
  c: 'c',
  cpp: 'cpp',
  objectivec: 'objective-c',
  csharp: 'csharp',
  fsharp: 'fsharp',
  go: 'go',
  rust: 'rust',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  perl: 'perl',
  r: 'r',
  julia: 'julia',
  haskell: 'haskell',
  elixir: 'elixir',
  erlang: 'erlang',
  clojure: 'clojure',
  lisp: 'lisp',
  scheme: 'scheme',
  ocaml: 'ocaml',
  reason: 'reason',
  nim: 'nim',
  zig: 'zig',
  v: 'vlang',
  crystal: 'crystal',
  d: 'd',
  sql: 'database',
  graphql: 'graphql',
  solidity: 'solidity',
  nasm: 'assembly',
  nix: 'nix',
  hcl: 'terraform',
  puppet: 'puppet',
  latex: 'tex',
  bibtex: 'bibliography',
  markdown: 'markdown',
  asciidoc: 'asciidoc',
  text: 'document',
  vim: 'vim',
  makefile: 'makefile',
  cmake: 'cmake',
  diff: 'diff',
  prisma: 'prisma',
  protobuf: 'proto',
  thrift: 'document',
  wasm: 'webassembly',
  glsl: 'shader',
  hlsl: 'shader',
  cg: 'shader',
  apacheconf: 'settings',
  nginx: 'nginx',
};

const extensionIconMap: Record<string, string> = {
  yml: 'yaml',
  mdx: 'mdx',
  md: 'markdown',
  lock: 'lock',
  env: 'settings',
  zip: 'zip',
  tgz: 'zip',
  gz: 'zip',
  rar: 'zip',
  '7z': 'zip',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'svg',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'favicon',
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  ogg: 'audio',
  mp4: 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  webm: 'video',
  pdf: 'pdf',
  doc: 'word',
  docx: 'word',
  ppt: 'powerpoint',
  pptx: 'powerpoint',
};

const fallbackIconName = 'document';

const selectVariantIconName = (iconName: string, variant: ThemeVariant): string => {
  if (!iconName) {
    return variant === 'light' ? `${fallbackIconName}_light` : fallbackIconName;
  }

  if (variant === 'light') {
    const lightName = iconName.endsWith('_light') ? iconName : `${iconName}_light`;
    return FILE_TYPE_ICON_IDS.has(lightName) ? lightName : iconName;
  }

  return iconName;
};

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim().length > 0;
};

const resolveIconName = (filePath: string, extension?: string): string => {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const fileName = normalizedPath.split('/').pop()?.toLowerCase() || '';

  if (fileNameIconMap[fileName]) {
    return fileNameIconMap[fileName];
  }
  if (fileName.startsWith('.env')) {
    return 'settings';
  }
  if (fileName.endsWith('.excalidraw.md')) {
    return 'excalidraw';
  }

  const language = getLanguageFromExtension(filePath);
  if (language && languageIconMap[language]) {
    return languageIconMap[language];
  }

  const normalizedExtension = isNonEmptyString(extension)
    ? extension.toLowerCase()
    : fileName.includes('.')
      ? fileName.split('.').pop()?.toLowerCase() || ''
      : '';

  if (normalizedExtension && extensionIconMap[normalizedExtension]) {
    return extensionIconMap[normalizedExtension];
  }

  if (normalizedExtension && FILE_TYPE_ICON_IDS.has(normalizedExtension)) {
    return normalizedExtension;
  }

  return fallbackIconName;
};

export const getFileTypeIconHref = (
  filePath: string,
  options?: { extension?: string; themeVariant?: ThemeVariant }
): string => {
  ensureFileTypeSprite();
  const resolvedBaseIconName = resolveIconName(filePath, options?.extension);
  const baseIconName = FILE_TYPE_ICON_IDS.has(resolvedBaseIconName) ? resolvedBaseIconName : fallbackIconName;
  const iconName = selectVariantIconName(baseIconName, options?.themeVariant || 'dark');
  return `#${iconName}`;
};
