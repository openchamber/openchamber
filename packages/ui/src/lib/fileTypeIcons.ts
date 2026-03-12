import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { FILE_TYPE_ICON_IDS } from '@/lib/fileTypeIconIds';
import spriteUrl from '../assets/icons/file-types/sprite.svg';

type ThemeVariant = 'light' | 'dark';

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
  const resolvedBaseIconName = resolveIconName(filePath, options?.extension);
  const baseIconName = FILE_TYPE_ICON_IDS.has(resolvedBaseIconName) ? resolvedBaseIconName : fallbackIconName;
  const iconName = selectVariantIconName(baseIconName, options?.themeVariant || 'dark');
  return `${spriteUrl}#${iconName}`;
};

export const getFileTypeIconUrl = getFileTypeIconHref;
